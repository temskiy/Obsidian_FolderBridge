import { App, DataAdapter, DataWriteOptions, FuzzySuggestModal, Plugin, PluginSettingTab, Setting, Notice, normalizePath, TAbstractFile, TFolder, TFile } from 'obsidian';
import { FolderBridgeSettings, MountPoint, DEFAULT_SETTINGS } from './src/types';
import { Language } from './src/i18n/types';
import { PathMapper } from './src/PathMapper';
import { VirtualAdapter } from './src/VirtualAdapter';
import { SecurityManager } from './src/SecurityManager';
import { MountManagerModal, getMountStatus, browseFolderOnDisk, browseMultipleFoldersOnDisk, VaultFolderPickerModal } from './src/ui/MountManagerModal';
import { MountRootDeleteModal } from './src/ui/MountRootDeleteModal';
import { WelcomeModal } from './src/ui/WelcomeModal';
import { DestinationPickerModal } from './src/ui/DestinationPickerModal';
import { LargeFileWarningModal } from './src/ui/LargeFileWarningModal';
import { ConflictResolutionModal } from './src/ui/ConflictResolutionModal';
import { checkPathAccessible, getPlatform, realPathToResourceUrl, tryReadAsDataUri } from './src/OSHelpers';
import { FileServer } from './src/FileServer';
import {
	encryptCredential, decryptCredential,
	saveSessionCredential, clearSessionCredential,
	saveWebDAVPassword, clearWebDAVPassword,
} from './src/CredentialStore';
import { setDebugLogging } from './src/logger';
import { FileWatcher } from './src/FileWatcher';
import { WebDAVAdapter } from './src/WebDAVAdapter';
import { S3Adapter } from './src/S3Adapter';
import { SFTPAdapter } from './src/SFTPAdapter';
import { logger } from './src/logger';
import { loadOptionalNodeModule } from './src/runtimeNode';
import { replayMountContentsToVault } from './src/mountScan';
import { parseTocConfig, serializeTocConfig } from './src/TocConfig';
import { i18n } from './src/i18n';
import { getAvailableDestinations } from './src/FileTransfer';

// Lazy-loaded Node.js builtins — safe on Obsidian Mobile (Capacitor).
const fs: typeof import('fs') = loadOptionalNodeModule<typeof import('fs')>('fs') ?? null as never;
const path: typeof import('path') = loadOptionalNodeModule<typeof import('path')>('path') ?? null as never;

// ---------------------------------------------------------------------------
// Private Obsidian internals accessed via type-safe casts.
// ---------------------------------------------------------------------------

/** Vault properties not in the public API but stable across Obsidian versions. */
type VaultInternal = {
	onChange(event: string, path: string, prev: null, stat: { type: string; ctime: number; mtime: number; size: number } | null): Promise<void>;
	adapter: DataAdapter;
	getResourcePath?(file: TFile): string;
	create?(path: string, data: string, options?: unknown): Promise<TFile | null>;
	createBinary?(path: string, data: ArrayBuffer, options?: unknown): Promise<TFile | null>;
};

/** App properties not in the public API but stable across Obsidian versions. */
type AppInternal = {
	setting?: { open?(): void; openTabById?(id: string): void };
	openWithDefaultApp?(filePath: string): void;
};

type FileExplorerFolderItem = {
	setCollapsed?: (collapsed: boolean) => void;
	collapsed?: boolean;
	isCollapsed?: boolean;
	el?: HTMLElement;
	selfEl?: HTMLElement;
	containerEl?: HTMLElement;
	titleEl?: HTMLElement;
};

type FileExplorerView = {
	fileItems?: Record<string, FileExplorerFolderItem>;
};

type DesktopVaultAdapter = DataAdapter & {
	getBasePath?(): string;
};

/** Minimal interface for the Electron module shell. */
type ElectronShell = { openPath(p: string): Promise<string> };
type ElectronModule = { shell?: ElectronShell; default?: { shell?: ElectronShell } };

const GITHUB_REPO_URL = 'https://github.com/tescolopio/Obsidian_FolderBridge';
const GITHUB_PROFILE_URL = 'https://github.com/tescolopio';
const BUY_ME_COFFEE_URL = 'https://buymeacoffee.com/tescolopio';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(): string {
	return Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}

function openExternalUrl(url: string): void {
	window.open(url, '_blank', 'noopener,noreferrer');
}

function backgroundTask(task: Promise<void>, context: string): void {
	void task.catch(error => {
		logger.error(`[FolderBridge] ${context}`, error);
		new Notice(i18n.t('status.refresh.failed'));
	});
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default class FolderBridgePlugin extends Plugin {
	settings: FolderBridgeSettings;
	pathMapper: PathMapper;
	security: SecurityManager;
	virtualAdapter: VirtualAdapter | null = null;
	fileWatcher: FileWatcher | null = null;
	private persistedMountPoints: MountPoint[] = [];
	private persistedAllowlist: string[] = [];
	private managedTocMountPoints: MountPoint[] = [];
	private externalTocMountPoints: MountPoint[] = [];
	private tocWarnings: string[] = [];
	/** Runtime-resolved managed TOC path (primary or fallback, whichever is accessible). */
	resolvedManagedTocSource = '';
	private managedTocRevision = 0;
	private pendingManagedTocResolution: Promise<void> = Promise.resolve();
	private mountInjections = new Map<string, symbol>();
	private mountUpdates = new Map<string, Promise<void>>();
	/** Localhost HTTP server — streams video/audio from local mounts with range-request support. */
	fileServer: FileServer = new FileServer();

	// Preserve original adapter so we can restore it on unload
	private originalAdapter: unknown = null;
	// Preserve original vault.getResourcePath so we can restore it on unload
 	private originalVaultGetResourcePath: unknown = null;
 	// Preserve original vault.create / vault.createBinary so we can restore on unload
 	private originalVaultCreate: unknown = null;
 	private originalVaultCreateBinary: unknown = null;
 	// Preserve original vault adapter (FileSystemAdapter) for direct writes to the vault
 	private originalVaultAdapter: import('obsidian').DataAdapter | null = null;
 	// Preserve original app.openWithDefaultApp so we can restore it on unload
	private originalOpenWithDefaultApp: unknown = null;
	statusBarItem: HTMLElement | null = null;
	explorerObserver: MutationObserver | null = null;
	private observedExplorerEl: HTMLElement | null = null;
	private explorerTooltipRoots = new WeakSet<HTMLElement>();
	private explorerExpansionRoots = new WeakSet<HTMLElement>();
	private explorerExpansionSaveTimer: number | null = null;
	private explorerExpansionRevision = 0;
	private explorerExpansionDirty = false;
	private nativeTooltipObserver: MutationObserver | null = null;
	private activeExplorerMountTooltipText: string | null = null;
	private activeExplorerMountTooltipEl: HTMLElement | null = null;
	private explorerTimers = new Set<ReturnType<typeof setTimeout>>();
	private explorerUnloaded = false;

	/** Tracks reachability per mount.id; populated by the 30-second health-check loop. */
	mountHealthMap = new Map<string, boolean>();
	private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

	/** Stores all tag names for which commands have been registered (for cleanup). */
	private registeredTagNames = new Set<string>();

	isTocManagedMount(mount: MountPoint): boolean {
		return typeof mount.tocSourcePath === 'string' && mount.tocSourcePath.length > 0;
	}

	isManagedTocMount(mount: MountPoint): boolean {
		return this.isManagedTocSource(mount.tocSourcePath);
	}

	isUserEditableMount(mount: MountPoint): boolean {
		return !this.isTocManagedMount(mount) || this.isManagedTocMount(mount);
	}

	isMountEnabledOnThisDevice(mount: MountPoint): boolean {
		if (mount.deviceId === this.settings.deviceId) return true;
		if (this.settings.allowForeignMounts) return true;
		if (mount.deviceOverrides?.[this.settings.deviceId]) return true;
		if (mount.fallbackRealPath) return true;
		return false;
	}

	private async resolveMountPath(mount: MountPoint, isCurrent: () => boolean = () => true): Promise<void> {
		let resolvedPath: string | undefined;
		if (!this.isCloudMount(mount) && !mount.deviceOverrides?.[this.settings.deviceId] && mount.fallbackRealPath) {
			const primary = await checkPathAccessible(mount.realPath);
			if (!isCurrent()) return;
			if (!primary.accessible) {
				const fallback = await checkPathAccessible(mount.fallbackRealPath);
				if (!isCurrent()) return;
				if (fallback.accessible) resolvedPath = mount.fallbackRealPath;
			}
		}

		if (!isCurrent()) return;
		if (resolvedPath) {
			this.pathMapper.setResolvedPath(mount.id, resolvedPath);
			logger.debug(`Folder Bridge: using fallback path "${resolvedPath}" for "${mount.virtualPath}" (primary "${mount.realPath}" not accessible)`);
		} else {
			this.pathMapper.clearResolvedPath(mount.id);
		}
	}

	getTocWarnings(): string[] {
		return [...this.tocWarnings];
	}

	private getManagedTocSourcePath(): string | null {
		if (this.resolvedManagedTocSource) return this.resolvedManagedTocSource;
		const sourcePath = this.settings.managedTocSource?.trim();
		return sourcePath ? sourcePath : null;
	}

	resolveAndCacheManagedTocSource(): Promise<void> {
		const revision = ++this.managedTocRevision;
		this.pendingManagedTocResolution = this.resolveManagedTocSource(revision);
		return this.pendingManagedTocResolution;
	}

	private async resolveManagedTocSource(revision: number): Promise<void> {
		const primary = this.settings.managedTocSource?.trim();
		const fallback = this.settings.managedTocSourceFallback?.trim();
		let source = primary || fallback || '';
		for (const candidate of [primary, fallback]) {
			if (!candidate) continue;
			const resolved = await checkPathAccessible(candidate);
			if (revision !== this.managedTocRevision) return;
			if (resolved.accessible) {
				source = candidate;
				break;
			}
		}
		await this.refreshTocMountSources(false, source, revision);
	}

	private async waitForManagedTocResolution(): Promise<void> {
		let pending: Promise<void>;
		do {
			pending = this.pendingManagedTocResolution;
			await pending;
		} while (pending !== this.pendingManagedTocResolution);
	}

	private isManagedTocSource(sourcePath?: string): boolean {
		const managedSource = this.getManagedTocSourcePath();
		return !!managedSource && sourcePath === managedSource;
	}

	private canPersistToManagedToc(mountType?: MountPoint['mountType']): boolean {
		if (!this.getManagedTocSourcePath()) return false;
		return mountType === undefined || mountType === 'local' || mountType === 'vault';
	}

	private getSuggestedManagedTocSourcePath(): string | null {
		if (!path) return null;
		const adapter = this.app.vault.adapter as DesktopVaultAdapter;
		const basePath = typeof adapter.getBasePath === 'function' ? adapter.getBasePath() : '';
		return basePath ? path.join(basePath, 'folderbridge.managed.json') : null;
	}

	getSuggestedManagedTocPath(): string | null {
		return this.getSuggestedManagedTocSourcePath();
	}

	private resolveManagedTocSourcePath(inputPath: string): string {
		const trimmedPath = inputPath.trim();
		if (trimmedPath) return trimmedPath;
		return this.getSuggestedManagedTocSourcePath() ?? '';
	}

	private getManagedTocDraftMounts(): MountPoint[] {
		return this.managedTocMountPoints.map(mount => {
			const copy = { ...mount };
			delete copy.tocSourcePath;
			return copy;
		});
	}

	private getManagedTocIndex(id: string): number {
		return this.managedTocMountPoints.findIndex(mount => mount.id === id);
	}

	private async writeManagedTocMounts(mounts: MountPoint[]): Promise<boolean> {
		const sourcePath = this.getManagedTocSourcePath();
		if (!sourcePath) {
			new Notice(i18n.t('toc.manage.notice.configureFirst'));
			return false;
		}
		if (!fs?.promises || !path) {
			new Notice(i18n.t('toc.manage.notice.desktopOnly'));
			return false;
		}
		const unsupportedMount = mounts.find(mount => this.isCloudMount(mount));
		if (unsupportedMount) {
			new Notice(i18n.t('toc.manage.notice.unsupportedType', { mount: unsupportedMount.label || unsupportedMount.virtualPath }));
			return false;
		}

		await fs.promises.mkdir(path.dirname(sourcePath), { recursive: true });
		await fs.promises.writeFile(sourcePath, serializeTocConfig(mounts), 'utf8');
		return true;
	}

	async bindManagedTocSource(sourcePath: string): Promise<boolean> {
		const trimmedPath = this.resolveManagedTocSourcePath(sourcePath);
		if (!trimmedPath) {
			new Notice(i18n.t('toc.manage.notice.noPath'));
			return false;
		}

		const previousSource = this.settings.managedTocSource;
		const previousResolved = this.resolvedManagedTocSource;
		const revision = ++this.managedTocRevision;
		this.settings.managedTocSource = trimmedPath;
		this.resolvedManagedTocSource = trimmedPath;
		this.settings.tocSources = this.settings.tocSources.filter(item => item.trim() !== trimmedPath);

		const binding = (async () => {
			try {
				if (!await this.writeManagedTocMounts(this.getManagedTocDraftMounts())) {
					if (revision === this.managedTocRevision) {
						this.settings.managedTocSource = previousSource;
						this.resolvedManagedTocSource = previousResolved;
					}
					return false;
				}
				if (revision !== this.managedTocRevision) return false;
				await this.refreshTocMountSources(true, trimmedPath, revision);
				if (revision !== this.managedTocRevision) return false;
				await this.saveSettings();
				return true;
			} catch (error) {
				if (revision === this.managedTocRevision) {
					this.settings.managedTocSource = previousSource;
					this.resolvedManagedTocSource = previousResolved;
				}
				const message = error instanceof Error ? error.message : String(error);
				new Notice(i18n.t('toc.manage.notice.initFailed', { message }));
				return false;
			}
		})();
		this.pendingManagedTocResolution = binding.then(() => { });
		return binding;
	}

	async createManagedTocFromCurrentMounts(sourcePath: string): Promise<{ success: boolean; moved: number; skipped: number; targetPath: string | null }> {
		const targetPath = this.resolveManagedTocSourcePath(sourcePath);
		if (!targetPath) {
			new Notice(i18n.t('toc.manage.notice.enterPath'));
			return { success: false, moved: 0, skipped: 0, targetPath: null };
		}

		const bindSucceeded = await this.bindManagedTocSource(targetPath);
		if (!bindSucceeded) {
			return { success: false, moved: 0, skipped: 0, targetPath: null };
		}

		const migration = await this.migrateLocalManualMountsToManagedToc();
		return {
			success: true,
			moved: migration.moved,
			skipped: migration.skipped,
			targetPath,
		};
	}

	async unbindManagedTocSource(): Promise<boolean> {
		this.managedTocRevision++;
		this.persistedMountPoints.push(...this.getManagedTocDraftMounts());
		this.managedTocMountPoints = [];
		this.settings.managedTocSource = '';
		this.settings.managedTocSourceFallback = '';
		this.resolvedManagedTocSource = '';
		await this.refreshTocMountSources();
		await this.saveSettings();
		return true;
	}

	async migrateLocalManualMountsToManagedToc(): Promise<{ moved: number; skipped: number }> {
		const sourcePath = this.getManagedTocSourcePath();
		if (!sourcePath) {
			new Notice(i18n.t('toc.manage.notice.configureFirst'));
			return { moved: 0, skipped: 0 };
		}

		const movableMounts = this.persistedMountPoints.filter(mount => !this.isCloudMount(mount));
		const skipped = this.persistedMountPoints.length - movableMounts.length;
		if (movableMounts.length === 0) {
			return { moved: 0, skipped };
		}

		const nextManagedMounts = [...this.getManagedTocDraftMounts(), ...movableMounts];
		if (!await this.writeManagedTocMounts(nextManagedMounts)) {
			return { moved: 0, skipped };
		}

		this.persistedMountPoints = this.persistedMountPoints.filter(mount => this.isCloudMount(mount));
		await this.refreshTocMountSources(true);
		await this.saveSettings();
		return { moved: movableMounts.length, skipped };
	}

	async persistEditableMountFromState(mount: MountPoint): Promise<boolean> {
		if (!this.isUserEditableMount(mount)) return false;

		if (this.isManagedTocMount(mount)) {
			const managedIndex = this.getManagedTocIndex(mount.id);
			if (managedIndex === -1) return false;

			const nextManagedMounts = this.getManagedTocDraftMounts();
			const updatedMount = { ...mount };
			delete updatedMount.tocSourcePath;
			nextManagedMounts[managedIndex] = updatedMount;
			if (!await this.writeManagedTocMounts(nextManagedMounts)) return false;
			await this.refreshTocMountSources(true);
			await this.saveSettings();
			return true;
		}

		await this.saveSettings();
		this.syncEffectiveMountState();
		return true;
	}

	addManualAllowlistPath(realPath: string): void {
		if (!this.persistedAllowlist.includes(realPath)) {
			this.persistedAllowlist.push(realPath);
		}
		this.security?.allow(realPath);
	}

	resyncEffectiveMountState(): void {
		this.syncEffectiveMountState();
	}

	private effectiveRealPathForAllowlist(mount: MountPoint): string {
		return mount.deviceOverrides?.[this.settings.deviceId] ?? mount.realPath;
	}

	private isCloudMount(mount: Pick<MountPoint, 'mountType'>): boolean {
		return mount.mountType === 'webdav' || mount.mountType === 's3' || mount.mountType === 'sftp';
	}

	private syncEffectiveMountState(): void {
		const effectiveMounts = [
			...this.persistedMountPoints,
			...this.managedTocMountPoints,
			...this.externalTocMountPoints,
		];
		const effectiveAllowlist = Array.from(new Set([
			...this.persistedAllowlist,
			...effectiveMounts
				.filter(m => !this.isCloudMount(m))
				.flatMap(m => [this.effectiveRealPathForAllowlist(m), m.fallbackRealPath])
				.filter((resolvedPath): resolvedPath is string => !!resolvedPath),
		]));

		this.settings.mountPoints = effectiveMounts;
		this.settings.allowlist = effectiveAllowlist;
		this.pathMapper?.update(this.settings.mountPoints, this.settings.deviceId);
		this.security?.setAllowlist(effectiveAllowlist);
	}

	async refreshTocMountSources(notifyOnWarnings = false, source = this.getManagedTocSourcePath(), revision = this.managedTocRevision): Promise<void> {
		this.tocWarnings = [];
		const validator = this.security ?? new SecurityManager(this.persistedAllowlist);
		const managedSource = source;
		const externalSources = Array.from(new Set(
			this.settings.tocSources
				.map(source => source.trim())
				.filter(Boolean)
				.filter(source => source !== managedSource)
		));

		if (!managedSource && externalSources.length === 0) {
			if (revision !== this.managedTocRevision) return;
			this.resolvedManagedTocSource = '';
			this.managedTocMountPoints = [];
			this.externalTocMountPoints = [];
			this.syncEffectiveMountState();
			this.updateIgnoreCache();
			return;
		}

		if (!fs?.promises) {
			this.tocWarnings = ['TOC config files are only supported on desktop builds with filesystem access.'];
			this.managedTocMountPoints = [];
			this.externalTocMountPoints = [];
			this.syncEffectiveMountState();
			this.updateIgnoreCache();
			if (notifyOnWarnings) {
				for (const warning of this.tocWarnings) {
					new Notice(i18n.t('notice.generic', { message: warning }));
				}
			}
			return;
		}

		const managedMounts: MountPoint[] = [];
		const externalMounts: MountPoint[] = [];
		const warnings: string[] = [];

		if (managedSource) {
			try {
				const text = await fs.promises.readFile(managedSource, 'utf8');
				const parsed = parseTocConfig(text, managedSource, this.settings.deviceId);
				warnings.push(...parsed.warnings);

				for (const candidate of parsed.mounts) {
					const error = validator.validateMount(candidate, [...this.persistedMountPoints, ...managedMounts]);
					if (error) {
						warnings.push(`${managedSource}: skipped mount "${candidate.virtualPath}" (${error})`);
						continue;
					}
					managedMounts.push(candidate);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				warnings.push(`${managedSource}: Failed to load config file (${message}).`);
			}
		}

		for (const sourcePath of externalSources) {
			const trimmedPath = sourcePath.trim();
			if (!trimmedPath) continue;
			try {
				const text = await fs.promises.readFile(trimmedPath, 'utf8');
				const parsed = parseTocConfig(text, trimmedPath, this.settings.deviceId);
				warnings.push(...parsed.warnings);

				for (const candidate of parsed.mounts) {
					const error = validator.validateMount(candidate, [...this.persistedMountPoints, ...managedMounts, ...externalMounts]);
					if (error) {
						warnings.push(`${trimmedPath}: skipped mount "${candidate.virtualPath}" (${error})`);
						continue;
					}
					externalMounts.push(candidate);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				warnings.push(`${trimmedPath}: Failed to load config file (${message}).`);
			}
		}

		if (revision !== this.managedTocRevision) return;
		this.resolvedManagedTocSource = managedSource ?? '';
		this.managedTocMountPoints = managedMounts;
		this.externalTocMountPoints = externalMounts;
		this.tocWarnings = warnings;
		this.syncEffectiveMountState();
		this.updateIgnoreCache();

		if (notifyOnWarnings) {
			for (const warning of warnings) {
				new Notice(i18n.t('notice.generic', { message: warning }));
			}
		}
	}

	async onload() {
		await this.loadSettings();

		// Initialize i18n after settings are loaded
		i18n.init(this.settings.language, this.manifest.name);

		this.pathMapper = new PathMapper();
		this.security = new SecurityManager(this.settings.allowlist);
		this.pathMapper.update(this.settings.mountPoints, this.settings.deviceId);

		// [FEATURE_20260222] Initialize FileWatcher
		this.fileWatcher = new FileWatcher(this.app, this.pathMapper, (name, mount, mountRelativePath) => this.isNameIgnored(name, mount, mountRelativePath));

		// Install the virtual adapter shim
		this.installVirtualAdapter();

		// Initialize plugin state from saved settings
		setDebugLogging(this.settings.debugLogging);
		this.virtualAdapter?.setEnableMountMerging(this.settings.enableMountMerging);
		this.virtualAdapter?.setDefaultCreationVault(this.settings.defaultCreationVault ?? 'vault');

		// Start the localhost streaming server for video/audio in local mounts.
		// Runs on a random available port; bound to 127.0.0.1 only.
		void this.fileServer.start().then(started => {
			if (!started) return; // mobile — unavailable
			// Register all currently active local mounts
			for (const m of this.settings.mountPoints) {
				if (m.enabled && m.realPath && !['webdav', 's3', 'sftp'].includes(m.mountType ?? '')) {
					this.fileServer.addAllowedPath(m.realPath);
					if (m.fallbackRealPath) {
						this.fileServer.addAllowedPath(m.fallbackRealPath);
					}
				}
			}
			this.virtualAdapter?.setFileServer(this.fileServer);
		}).catch(err => {
			logger.warn('[FolderBridge] FileServer failed to start (video streaming unavailable):', err);
		});

		// Ribbon icon opens the add-mount modal
		const ribbonIconEl = this.addRibbonIcon('folder-plus', `${this.manifest.name}: add mount`, () => {
			new MountManagerModal(this.app, this.manifest.name, this.security, (mount) => this.addMount(mount)).open();
		});
		ribbonIconEl.addClass('folderbridge-ribbon-class');

		// Status bar
		if (this.settings.showStatusBar) {
			this.statusBarItem = this.addStatusBarItem();
			this.updateStatusBar();
		}

		// Settings tab
		this.addSettingTab(new FolderBridgeSettingTab(this.app, this));

		// Add a command to manually refresh mounts
		this.addCommand({
			id: 'refresh-mounts',
			name: i18n.t('command.refreshMounts.name'),
			callback: () => {
				void (async () => {
					for (const mount of this.settings.mountPoints.filter(m => m.enabled && this.isMountEnabledOnThisDevice(m))) {
						await this.notifyVaultMountAdded(mount);
					}
					new Notice(i18n.t('status.refresh.done'));
				})();
			}
		});

		// Command: open add-mount modal
		this.addCommand({
			id: 'add-mount',
			name: i18n.t('command.addMount.name'),
			callback: () => {
				new MountManagerModal(this.app, this.manifest.name, this.security, (mount) => this.addMount(mount)).open();
			},
		});

		// Command: open plugin settings tab
		this.addCommand({
			id: 'open-settings',
			name: i18n.t('command.openSettings.name'),
			callback: () => {
				(this.app as App & AppInternal).setting?.open?.();
				(this.app as App & AppInternal).setting?.openTabById?.('folderbridge');
			},
		});

		// Command: toggle a mount (picker modal)
		this.addCommand({
			id: 'toggle-mount',
			name: i18n.t('command.toggleMount.name'),
			callback: () => {
				const myMounts = this.settings.mountPoints.filter(
					m => this.isUserEditableMount(m) && this.isMountEnabledOnThisDevice(m),
				);
				if (myMounts.length === 0) {
					new Notice(i18n.t('status.mount.noMounts'));
					return;
				}
				// Inline FuzzySuggestModal — avoids a separate file for a small feature
				const modal = new (class extends FuzzySuggestModal<MountPoint> {
					constructor(app: App, private readonly outerPlugin: FolderBridgePlugin) { super(app); }
					getItems() { return myMounts; }
					getItemText(m: MountPoint) {
						const status = m.enabled ? '✅' : '⏸';
						return `${status}  ${m.label || m.virtualPath}`;
					}
					onChooseItem(m: MountPoint) {
						void (async () => {
							const enabling = !m.enabled;
							// Must remove BEFORE setting enabled=false so adapter can still resolve paths
							if (!enabling) await this.outerPlugin.notifyVaultMountRemoved(m);
							m.enabled = enabling;
							await this.outerPlugin.persistEditableMountFromState(m);
							this.outerPlugin.pathMapper.update(this.outerPlugin.settings.mountPoints, this.outerPlugin.settings.deviceId);
							this.outerPlugin.updateStatusBar();
							if (enabling) {
								await this.outerPlugin.notifyVaultMountAdded(m);
								new Notice(i18n.t('status.mount.enable', { mount: m.label || m.virtualPath }));
							} else {
								new Notice(i18n.t('status.mount.disable', { mount: m.label || m.virtualPath }));
							}
						})();
					}
				})(this.app, this);
				modal.setPlaceholder(i18n.t('command.toggleMount.placeholder'));
				modal.open();
			},
		});

		// Command: reconnect all unreachable mounts
		this.addCommand({
			id: 'reconnect-mounts',
			name: i18n.t('command.reconnectMounts.name'),
			callback: () => {
				void (async () => {
					const unreachable = this.settings.mountPoints.filter(
						m => m.enabled && !this.mountHealthMap.get(m.id),
					);
					if (unreachable.length === 0) {
						new Notice(i18n.t('status.mount.reachable'));
						return;
					}
					let reconnected = 0;
					for (const mount of unreachable) {
						try {
							await this.reconnectMount(mount);
							reconnected++;
						} catch { /* individual failure already noticed inside reconnectMount */ }
					}
					new Notice(i18n.t('status.mount.refresh', { reconnected, unreachable: unreachable.length }));
				})();
			},
		});

		// ── Tag-based mount/unmount commands ─────────────────────────────────
		// Dynamically register commands for each unique tag found in mountPoints.
		// Commands are named with # prefix (e.g. "#work mount/unmount") to distinguish
		// from individual mount commands.
		this.refreshTagCommands();

		// Command: toggle read-only on ALL mounts belonging to this device
		this.addCommand({
			id: 'toggle-readonly-all',
			name: i18n.t('command.toggleReadOnlyAll.name'),
			callback: () => {
				void (async () => {
					const myMounts = this.settings.mountPoints.filter(m => this.isUserEditableMount(m) && m.deviceId === this.settings.deviceId);
					if (myMounts.length === 0) {
						new Notice(i18n.t('status.mount.noMounts'));
						return;
					}
					// If any mount is currently writable, make all read-only; otherwise unlock all.
					const anyWritable = myMounts.some(m => !m.readOnly);
					for (const m of myMounts) {
						await this.setMountReadOnly(m.id, anyWritable, /* skipNotice */ true);
					}
					new Notice(i18n.t('status.mount.toggle', {
						state: anyWritable ? i18n.t('state.readOnly').toLowerCase() : i18n.t('state.writable').toLowerCase(),
					}));
				})();
			},
		});

		// Command: toggle read-only on a specific mount (fuzzy picker)
		this.addCommand({
			id: 'toggle-readonly-mount',
			name: i18n.t('command.toggleReadOnlyMount.name'),
			callback: () => {
				const myMounts = this.settings.mountPoints.filter(
					m => this.isUserEditableMount(m) && this.isMountEnabledOnThisDevice(m),
				);
				if (myMounts.length === 0) {
					new Notice(i18n.t('status.mount.noMounts'));
					return;
				}
				const modal = new (class extends FuzzySuggestModal<MountPoint> {
					constructor(app: App, private readonly outerPlugin: FolderBridgePlugin) { super(app); }
					getItems() { return myMounts; }
					getItemText(m: MountPoint) {
						const state = m.readOnly ? i18n.t('state.readOnly') : i18n.t('state.writable');
						return `${state}  ${m.label || m.virtualPath}`;
					}
					onChooseItem(m: MountPoint) {
						void this.outerPlugin.setMountReadOnly(m.id, !m.readOnly);
					}
				})(this.app, this);
				modal.setPlaceholder(i18n.t('command.toggleReadOnlyMount.placeholder'));
				modal.open();
			},
		});

		// Command: toggle global watcher-event suppression (all mounts)
		this.addCommand({
			id: 'toggle-watcher-suppression-all',
			name: i18n.t('command.toggleWatcherAll.name'),
			callback: () => {
				const wasSuppressed = this.fileWatcher?.isSuppressedAll() ?? false;
				this.setWatcherSuppressed(null, !wasSuppressed);
				new Notice(
					!wasSuppressed ? i18n.t('watcher.suppressedAll') : i18n.t('watcher.restoredAll')
				);
			},
		});

		// Command: toggle watcher-event suppression for a specific mount
		this.addCommand({
			id: 'toggle-watcher-suppression-mount',
			name: i18n.t('command.toggleWatcherMount.name'),
			callback: () => {
				const myMounts = this.settings.mountPoints.filter(
					m => this.isMountEnabledOnThisDevice(m),
				);
				if (myMounts.length === 0) {
					new Notice(i18n.t('status.mount.noMounts'));
					return;
				}
				const modal = new (class extends FuzzySuggestModal<MountPoint> {
					constructor(app: App, private readonly outerPlugin: FolderBridgePlugin) { super(app); }
					getItems() { return myMounts; }
					getItemText(m: MountPoint) {
						const suppressed = this.outerPlugin.fileWatcher?.isSuppressed(m.id) ?? false;
						const state = suppressed ? i18n.t('state.suppressed') : i18n.t('state.active');
						return `${state}  ${m.label || m.virtualPath}`;
					}
					onChooseItem(m: MountPoint) {
						const suppressed = this.outerPlugin.fileWatcher?.isSuppressed(m.id) ?? false;
						this.outerPlugin.setWatcherSuppressed(m.id, !suppressed);
						new Notice(
							!suppressed
								? i18n.t('watcher.suppressedMount', { mount: m.label || m.virtualPath })
								: i18n.t('watcher.restoredMount', { mount: m.label || m.virtualPath })
						);
					}
				})(this.app, this);
				modal.setPlaceholder(i18n.t('command.toggleWatcherMount.placeholder'));
				modal.open();
			},
		});

		// Add context menu item to ignore files/folders
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				const mount = this.pathMapper.getMountForPath(file.path);

				if (file instanceof TFolder && !mount) {
					menu.addItem((item) => {
						item
							.setTitle(i18n.t('menu.mountExternalFolder'))
							.setIcon('folder-plus')
							.onClick(() => {
								new MountManagerModal(
									this.app,
									this.manifest.name,
									this.security,
									async (newMount) => { await this.addExplorerMount(newMount); },
									undefined,
									{
										mountType: 'local',
										virtualPath: this.getAvailableExplorerMountPath(file.path),
									},
								).open();
							});
					});
				}

				// Copy/Move context menu items — available for all files/folders
				if (this.settings.enableMoveCopyMenu ?? true) {
					// "Copy to…"
					menu.addItem((item) => {
						item
							.setTitle(i18n.t('menu.copyTo'))
							.setIcon('copy')
							.onClick(() => {
								void this.handleCopyMove(file, 'copy');
							});
					});

					// "Move to…"
					menu.addItem((item) => {
						item
							.setTitle(i18n.t('menu.moveTo'))
							.setIcon('arrow-right-circle')
							.onClick(() => {
								void this.handleCopyMove(file, 'move');
							});
					});
				}

				// The remaining context actions apply only inside mounted folders.
				if (!mount) return;

				// "Move mount to…" — only on the mount's own root folder
				const isMountRoot = file instanceof TFolder &&
					normalizePath(file.path) === normalizePath(mount.virtualPath) &&
					mount.deviceId === this.settings.deviceId;
				if (isMountRoot) {
					menu.addItem((item) => {
						item
							.setTitle(i18n.t('menu.moveMountTo'))
							.setIcon('folder-input')
							.onClick(() => {
								new VaultFolderPickerModal(this.app, async (newParent) => {
									const leaf = normalizePath(mount.virtualPath).split('/').pop() || '';
									const newVirtualPath = newParent
										? normalizePath(`${newParent}/${leaf}`)
										: leaf;
									if (newVirtualPath === normalizePath(mount.virtualPath)) return;
									await this.updateMount(mount.id, { ...mount, virtualPath: newVirtualPath });
								}).open();
							});
					});
				}

				menu.addItem((item) => {
					item
						.setTitle(i18n.t('menu.ignore', { name: file.name }))
						.setIcon('eye-off')
						.onClick(() => {
							void (async () => {
								if (!this.isNameIgnored(file.name, mount)) {
									if (!mount.ignoreList) mount.ignoreList = [];
									mount.ignoreList.push(file.name);
									await this.saveSettings();
									new Notice(i18n.t('ignore.added', { name: file.name, mount: mount.virtualPath }));

									// Remove it from the vault view immediately
									const vault = this.app.vault as typeof this.app.vault & VaultInternal;
									if (typeof vault.onChange === 'function') {
										try {
											if (file instanceof TFolder) {
												await vault.onChange('folder-removed', file.path, null, null);
											} else if (file instanceof TFile) {
												await vault.onChange('file-removed', file.path, null, null);
											}
										} catch (e) {
											logger.debug('Folder Bridge: Failed to remove ignored item from view', e);
										}
									}
								} else {
									new Notice(i18n.t('ignore.already', { name: file.name }));
								}
							})();
						});
				});
			})
		);

		// After the workspace finishes loading, inject all enabled mounts into
		// Obsidian's internal vault file tree so they appear in the file explorer
		// without requiring a restart.
		this.app.workspace.onLayoutReady(() => {
			void (async () => {
				// [BUGFIX_20260222] Removed debug log for resource path format

				const activeMounts = this.settings.mountPoints.filter(m => m.enabled && this.isMountEnabledOnThisDevice(m));

				// Register adapters for all active mounts — each type handled in its own branch.
				for (const mount of activeMounts) {
					if (mount.mountType === 'webdav') {
						// Decrypt the persisted password into sessionStorage so fromMount() can pick it up.
						if (mount.encryptedWebdavPassword) {
							const plain = decryptCredential(mount.encryptedWebdavPassword);
							if (plain) saveWebDAVPassword(mount.id, plain);
						}
						const adapter = WebDAVAdapter.fromMount(mount);
						if (adapter) this.virtualAdapter?.setWebDAVAdapter(mount.id, adapter);
					} else if (mount.mountType === 's3') {
						// Decrypt secret key so S3Adapter.fromMount() can build the client.
						if (mount.encryptedS3SecretKey) {
							const plain = decryptCredential(mount.encryptedS3SecretKey);
							if (plain) saveSessionCredential('s3', mount.id, plain);
						}
						const s3 = S3Adapter.fromMount(mount);
						if (s3) this.virtualAdapter?.setS3Adapter(mount.id, s3);
					} else if (mount.mountType === 'sftp') {
						// Decrypt SFTP credentials into sessionStorage.
						if (mount.encryptedSftpPassword) {
							const plain = decryptCredential(mount.encryptedSftpPassword);
							if (plain) saveSessionCredential('sftp-pw', mount.id, plain);
						}
						if (mount.encryptedSftpPassphrase) {
							const plain = decryptCredential(mount.encryptedSftpPassphrase);
							if (plain) saveSessionCredential('sftp-pp', mount.id, plain);
						}
						const sftpAdapter = SFTPAdapter.fromMount(mount);
						if (sftpAdapter) this.virtualAdapter?.setSFTPAdapter(mount.id, sftpAdapter);
					}
				}

				// Highlight mounted folders in the file explorer
				this.setupExplorerHighlighting();

				for (const mount of activeMounts) {
					await this.notifyVaultMountAdded(mount);
				}
				// Start background reachability checks after initial mount injection
				this.startHealthChecks();

				// Show first-run welcome modal for new users
				if (!this.settings.hasSeenOnboarding) {
					this.settings.hasSeenOnboarding = true;
					await this.saveSettings();
					new WelcomeModal(
						this.app,
						() => new MountManagerModal(
							this.app,
							this.manifest.name,
							this.security,
							async (mount) => { await this.addMount(mount); },
						).open(),
						() => { /* dismissed */ },
					).open();
				} else {
					const inactiveMounts = this.settings.mountPoints.filter(mount => mount.enabled && !this.isMountEnabledOnThisDevice(mount));
					if (inactiveMounts.length > 0) {
						new Notice(
							`Folder Bridge: ${inactiveMounts.length} mount(s) from another device are inactive here. ` +
							`Open Folder Bridge settings and choose "Use path on this device" to activate them.`,
							10000,
						);
					}
				}
			})();
		});

		logger.debug(`Folder Bridge Loaded (${getPlatform()}, ${this.settings.mountPoints.filter(m => m.enabled && this.isMountEnabledOnThisDevice(m)).length} active mounts on this device)`);
	}

	onunload() {
		this.explorerUnloaded = true;
		for (const timer of this.explorerTimers) clearTimeout(timer);
		this.explorerTimers.clear();
		this.mountInjections.clear();
		this.managedTocRevision++;
		if (this.explorerExpansionSaveTimer !== null) {
			window.clearTimeout(this.explorerExpansionSaveTimer);
			this.explorerExpansionSaveTimer = null;
		}
		if (this.explorerExpansionDirty) void this.flushExplorerExpansionState();
		// Stop the file-explorer highlighting observer
		this.teardownExplorerHighlighting();
		this.teardownNativeTooltipObserver();
		// Stop background health-check loop before watcher so no stale notices fire
		if (this.healthCheckInterval !== null) {
			clearInterval(this.healthCheckInterval);
			this.healthCheckInterval = null;
		}
		// [FEATURE_20260222] Stop all file watchers
		this.fileWatcher?.stopAll();

		// Restore the original adapter so the vault works normally after unload
		if (this.originalAdapter) {
			(this.app.vault as typeof this.app.vault & VaultInternal).adapter = this.originalAdapter as DataAdapter;
			this.originalAdapter = null;
		}

		// Restore the original vault.getResourcePath
		if (this.originalVaultGetResourcePath) {
			(this.app.vault as typeof this.app.vault & VaultInternal).getResourcePath = this.originalVaultGetResourcePath as (file: TFile) => string;
			this.originalVaultGetResourcePath = null;
		}

		// Restore the original vault.create / vault.createBinary
		if (this.originalVaultCreate) {
			(this.app.vault as unknown as { create?: unknown }).create = this.originalVaultCreate;
			this.originalVaultCreate = null;
		}
		if (this.originalVaultCreateBinary) {
			(this.app.vault as unknown as { createBinary?: unknown }).createBinary = this.originalVaultCreateBinary;
			this.originalVaultCreateBinary = null;
		}

		// Restore the original app.openWithDefaultApp
		if (this.originalOpenWithDefaultApp) {
			(this.app as App & AppInternal).openWithDefaultApp = this.originalOpenWithDefaultApp as (filePath: string) => void;
			this.originalOpenWithDefaultApp = null;
		}

		// Stop the localhost streaming server
		this.fileServer.stop();

		logger.debug('Folder Bridge Unloaded');
	}

	// ------------------------------------------------------------------
	// Helpers
	// ------------------------------------------------------------------

	/**
	 * Set up a MutationObserver on the file-explorer DOM to add visual
	 * indicators (CSS classes) to mounted folders in the tree.
	 *
	 * Tooltip: the file explorer renders its file-count tooltip internally, so
	 * mount details are merged into the already-open tooltip during hover.
	 */
	setupExplorerHighlighting(): void {
		this.teardownExplorerHighlighting();

		const apply = () => this.highlightMountedInExplorer();

		const tryObserve = () => {
			const leaves = this.app.workspace.getLeavesOfType('file-explorer');
			if (!leaves.length) return;
			const explorerEl = leaves[0].view.containerEl;
			this.registerExplorerTooltipAugmentation(explorerEl);
			this.registerExplorerExpansionTracking(explorerEl);
			this.setupNativeTooltipObserver();

			if (this.observedExplorerEl !== explorerEl) {
				this.explorerObserver?.disconnect();
				this.explorerObserver = null;
				this.observedExplorerEl = explorerEl;
			}
			if (this.explorerObserver) {
				apply();
				return;
			}

			this.explorerObserver = new MutationObserver(() => apply());
			this.explorerObserver.observe(explorerEl, { childList: true, subtree: true });
			apply();
		};

		// Initial attempt
		tryObserve();

		// Re-attach when the file explorer is opened/closed
		this.registerEvent(this.app.workspace.on('layout-change', () => {
			// If the observer was lost (file explorer was closed), clean up
			if (this.explorerObserver) {
				// Check if the observed element is still in the DOM
				const leaves = this.app.workspace.getLeavesOfType('file-explorer');
				const stillAlive = leaves.length > 0 &&
					document.contains(leaves[0].view.containerEl);
				if (!stillAlive) {
					this.explorerObserver.disconnect();
					this.explorerObserver = null;
				}
			}
			tryObserve();
		}));
	}

	teardownExplorerHighlighting(): void {
		if (this.explorerObserver) {
			this.explorerObserver.disconnect();
			this.explorerObserver = null;
		}
		this.observedExplorerEl = null;
		for (const leaf of this.app.workspace.getLeavesOfType('file-explorer')) {
			leaf.view.containerEl.querySelectorAll<HTMLElement>(
				'.folderbridge-mounted, .folderbridge-mounted-child, .folderbridge-highlighted'
			).forEach(el => {
				el.classList.remove('folderbridge-mounted', 'folderbridge-mounted-child', 'folderbridge-highlighted');
				el.removeAttribute('data-folderbridge-mount-type');
				el.style.removeProperty('--highlight-color');
				this.clearExplorerMountMetadata(el);
			});
		}
	}

	private setupNativeTooltipObserver(): void {
		if (this.nativeTooltipObserver || !document.body) return;

		this.nativeTooltipObserver = new MutationObserver(() => {
			if (this.activeExplorerMountTooltipText) {
				this.appendMountInfoToNativeTooltip(this.activeExplorerMountTooltipText);
			} else {
				this.removeMountInfoFromNativeTooltips();
			}
		});
		this.nativeTooltipObserver.observe(document.body, { childList: true, subtree: true });
	}

	private teardownNativeTooltipObserver(): void {
		if (this.nativeTooltipObserver) {
			this.nativeTooltipObserver.disconnect();
			this.nativeTooltipObserver = null;
		}
		this.activeExplorerMountTooltipText = null;
		this.activeExplorerMountTooltipEl = null;
		this.removeMountInfoFromNativeTooltips();
	}

	private registerExplorerTooltipAugmentation(explorerEl: HTMLElement): void {
		if (this.explorerTooltipRoots.has(explorerEl)) return;
		this.explorerTooltipRoots.add(explorerEl);

		this.registerDomEvent(explorerEl, 'mouseover', (event: MouseEvent) => {
			const target = event.target;
			if (!(target instanceof HTMLElement)) return;

			const titleEl = target.closest<HTMLElement>('.nav-folder-title, .nav-file-title');
			if (!titleEl || !explorerEl.contains(titleEl)) return;

			const folderTitleEl = titleEl.matches('.nav-folder-title.folderbridge-mounted')
				? titleEl
				: null;
			if (!folderTitleEl) {
				this.activeExplorerMountTooltipText = null;
				this.activeExplorerMountTooltipEl = null;
				this.removeMountInfoFromNativeTooltips();
				return;
			}

			this.scheduleNativeTooltipAugmentation(folderTitleEl);
		}, true);

		this.registerDomEvent(explorerEl, 'mouseout', (event: MouseEvent) => {
			const target = event.target;
			if (!(target instanceof HTMLElement)) return;

			const folderTitleEl = target.closest<HTMLElement>('.nav-folder-title.folderbridge-mounted');
			if (!folderTitleEl || !explorerEl.contains(folderTitleEl)) return;

			const relatedTarget = event.relatedTarget;
			if (relatedTarget instanceof Node && folderTitleEl.contains(relatedTarget)) return;

			this.activeExplorerMountTooltipText = null;
			this.activeExplorerMountTooltipEl = null;
			this.removeMountInfoFromNativeTooltips();
		}, true);
	}

	private registerExplorerExpansionTracking(explorerEl: HTMLElement): void {
		if (this.explorerExpansionRoots.has(explorerEl)) return;
		this.explorerExpansionRoots.add(explorerEl);

		const scheduleFromEvent = (event: Event) => {
			const target = event.target;
			if (!(target instanceof HTMLElement)) return;

			const titleEl = target.closest<HTMLElement>('.nav-folder-title');
			if (!titleEl || !explorerEl.contains(titleEl)) return;

			const dataPath = titleEl.getAttribute('data-path');
			if (!dataPath || !this.isFolderBridgeExplorerPath(dataPath)) return;

			this.scheduleExplorerExpansionStateCapture(explorerEl);
		};

		this.registerDomEvent(explorerEl, 'click', scheduleFromEvent, true);
		this.registerDomEvent(explorerEl, 'keydown', (event: KeyboardEvent) => {
			if (!['Enter', ' ', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
			scheduleFromEvent(event);
		}, true);
	}

	private getFileExplorerView(): FileExplorerView | null {
		const leaves = this.app.workspace.getLeavesOfType('file-explorer');
		if (!leaves.length) return null;
		return leaves[0].view as unknown as FileExplorerView;
	}

	private isFolderBridgeExplorerPath(pathValue: string): boolean {
		const normalized = normalizePath(pathValue);
		if (!normalized) return false;

		const activeMountPaths = this.settings.mountPoints
			.filter(m => m.enabled && this.isMountEnabledOnThisDevice(m))
			.map(m => normalizePath(m.virtualPath));

		return activeMountPaths.some(mountPath =>
			normalized === mountPath ||
			normalized.startsWith(mountPath + '/') ||
			mountPath.startsWith(normalized + '/')
		);
	}

	private scheduleExplorerExpansionStateCapture(explorerEl: HTMLElement): void {
		this.scheduleExplorerWork(() => this.captureExplorerExpansionState(explorerEl), 75);
		this.scheduleExplorerWork(() => this.captureExplorerExpansionState(explorerEl), 250);
	}

	private scheduleExplorerWork(callback: () => void, delay: number): void {
		if (this.explorerUnloaded) return;
		const timer = setTimeout(() => {
			this.explorerTimers.delete(timer);
			if (!this.explorerUnloaded) callback();
		}, delay);
		this.explorerTimers.add(timer);
	}

	private getAvailableExplorerMountPath(parent: string): string {
		const base = normalizePath(`${parent}/External`);
		let candidate = base;
		let suffix = 2;
		while (this.app.vault.getAbstractFileByPath(candidate) || this.pathMapper.getMountForPath(candidate)) {
			candidate = `${base} ${suffix++}`;
		}
		return candidate;
	}

	private async addExplorerMount(mount: Omit<MountPoint, 'id'>): Promise<void> {
		if (this.app.vault.getAbstractFileByPath(normalizePath(mount.virtualPath))) {
			throw new Error('Choose a new virtual folder; the selected path already exists in the vault.');
		}
		await this.addMount(mount);
	}

	private captureExplorerExpansionState(explorerEl: HTMLElement): void {
		let changed = false;
		const nextState = {
			...(this.settings.explorerExpansionState ?? {}),
		};

		explorerEl.querySelectorAll<HTMLElement>('.nav-folder-title[data-path]').forEach(titleEl => {
			const dataPath = titleEl.getAttribute('data-path');
			if (!dataPath || !this.isFolderBridgeExplorerPath(dataPath)) return;

			const normalized = normalizePath(dataPath);
			const expanded = this.readExplorerFolderExpanded(normalized, titleEl);
			if (expanded === null) return;

			if (nextState[normalized] !== expanded) {
				nextState[normalized] = expanded;
				changed = true;
			}
		});

		if (!changed) return;
		this.settings.explorerExpansionState = nextState;
		this.queueExplorerExpansionStateSave();
	}

	private queueExplorerExpansionStateSave(): void {
		this.explorerExpansionDirty = true;
		this.explorerExpansionRevision++;
		if (this.explorerExpansionSaveTimer !== null) {
			window.clearTimeout(this.explorerExpansionSaveTimer);
		}
		this.explorerExpansionSaveTimer = window.setTimeout(() => {
			this.explorerExpansionSaveTimer = null;
			void this.flushExplorerExpansionState();
		}, 500);
	}

	private async flushExplorerExpansionState(): Promise<void> {
		const revision = this.explorerExpansionRevision;
		try {
			await this.saveSettings();
			if (revision === this.explorerExpansionRevision) this.explorerExpansionDirty = false;
		} catch (error) {
			logger.error('Folder Bridge: could not save explorer expansion state', error);
			new Notice(i18n.t('status.expansionSaveFailed'));
		}
	}

	private readExplorerFolderExpanded(pathValue: string, titleEl?: HTMLElement): boolean | null {
		const item = this.getFileExplorerView()?.fileItems?.[normalizePath(pathValue)];
		if (typeof item?.collapsed === 'boolean') return !item.collapsed;
		if (typeof item?.isCollapsed === 'boolean') return !item.isCollapsed;

		const itemRoot = item?.selfEl ?? item?.containerEl ?? item?.el ?? item?.titleEl;
		const folderEl = titleEl?.closest<HTMLElement>('.nav-folder') ?? itemRoot?.closest<HTMLElement>('.nav-folder');
		if (!folderEl) return null;

		if (folderEl.classList.contains('is-collapsed')) return false;
		if (folderEl.classList.contains('is-expanded')) return true;

		const childContainer = folderEl.querySelector<HTMLElement>(':scope > .nav-folder-children');
		if (!childContainer) return null;
		return window.getComputedStyle(childContainer).display !== 'none';
	}

	private applySavedExplorerExpansionState(mount: MountPoint): void {
		const savedState = this.settings.explorerExpansionState ?? {};
		const savedPaths = Object.keys(savedState);
		if (savedPaths.length === 0) return;

		const mountPath = normalizePath(mount.virtualPath);
		const fileItems = this.getFileExplorerView()?.fileItems;
		if (!fileItems) return;

		for (const savedPath of savedPaths) {
			const normalized = normalizePath(savedPath);
			if (
				normalized !== mountPath &&
				!normalized.startsWith(mountPath + '/') &&
				!mountPath.startsWith(normalized + '/')
			) {
				continue;
			}

			const folderItem = fileItems[normalized];
			if (typeof folderItem?.setCollapsed === 'function') {
				folderItem.setCollapsed(!savedState[savedPath]);
			}
		}
	}

	private scheduleNativeTooltipAugmentation(folderTitleEl: HTMLElement): void {
		const tooltipText = folderTitleEl.dataset.folderbridgeMountTooltip;
		if (!tooltipText) return;
		this.activeExplorerMountTooltipText = tooltipText;
		this.activeExplorerMountTooltipEl = folderTitleEl;

		const apply = () => this.appendMountInfoToNativeTooltip(tooltipText);
		for (const delay of [0, 50, 150, 300, 600]) this.scheduleExplorerWork(apply, delay);
	}

	private appendMountInfoToNativeTooltip(tooltipText: string): void {
		if (this.explorerUnloaded || this.activeExplorerMountTooltipText !== tooltipText ||
			!this.activeExplorerMountTooltipEl?.isConnected || !this.activeExplorerMountTooltipEl.matches(':hover')) return;
		const tooltipEl = Array.from(document.querySelectorAll<HTMLElement>('.tooltip, [class~="tooltip"]'))
			.reverse()
			.find(el => {
				const rect = el.getBoundingClientRect();
				return rect.width > 0 && rect.height > 0;
			});
		if (!tooltipEl) return;

		const contentEl = this.findNativeTooltipContentEl(tooltipEl);
		const existingAugmented = tooltipEl.querySelector<HTMLElement>('.folderbridge-tooltip-augmented');
		if (existingAugmented?.dataset.folderbridgeText === tooltipText) return;

		const originalText = this.stripExplorerMountTooltipText(
			existingAugmented?.dataset.folderbridgeOriginalText ?? contentEl.textContent?.trim() ?? ''
		);
		tooltipEl.addClass('folderbridge-tooltip-container-augmented');
		const tooltipStyle = window.getComputedStyle(tooltipEl);
		const tooltipBackgroundColor = this.getVisibleBackgroundColor(tooltipEl);
		if (tooltipBackgroundColor) {
			tooltipEl.style.backgroundColor = tooltipBackgroundColor;
		}
		tooltipEl.style.color = tooltipStyle.color;

		contentEl.querySelectorAll<HTMLElement>('.folderbridge-tooltip-augmented').forEach(el => el.remove());
		Array.from(contentEl.childNodes).forEach(node => {
			if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
				node.remove();
			}
		});

		const augmentedEl = document.createElement('div');
		augmentedEl.className = 'folderbridge-tooltip-augmented';
		augmentedEl.dataset.folderbridgeOriginalText = originalText;
		augmentedEl.dataset.folderbridgeText = tooltipText;

		for (const line of [originalText, ...tooltipText.split('\n')].filter(Boolean)) {
			const lineEl = document.createElement('div');
			lineEl.className = 'folderbridge-tooltip-line';
			lineEl.textContent = line;
			augmentedEl.appendChild(lineEl);
		}
		contentEl.appendChild(augmentedEl);
	}

	private findNativeTooltipContentEl(tooltipEl: HTMLElement): HTMLElement {
		const existingAugmented = tooltipEl.querySelector<HTMLElement>('.folderbridge-tooltip-augmented');
		if (existingAugmented?.parentElement instanceof HTMLElement) return existingAugmented.parentElement;

		const candidates = [
			...Array.from(tooltipEl.querySelectorAll<HTMLElement>('*')),
			tooltipEl,
		];

		const visibleTextCandidates = candidates.filter(el => {
			if (el.classList.contains('folderbridge-tooltip-augmented')) return true;
			if (el.className.toString().includes('arrow')) return false;
			const rect = el.getBoundingClientRect();
			return rect.width > 0 && rect.height > 0 && !!el.textContent?.trim();
		});

		const leafTextEl = visibleTextCandidates.find(el =>
			!Array.from(el.children).some(child => child.textContent?.trim() === el.textContent?.trim())
		);
		if (leafTextEl) return leafTextEl;

		return tooltipEl.querySelector<HTMLElement>('.tooltip-content') ?? tooltipEl;
	}

	private stripExplorerMountTooltipText(text: string): string {
		const markerIndices = ['Mount:', 'Path:']
			.map(marker => text.indexOf(marker))
			.filter(index => index >= 0);
		const firstMarkerIndex = markerIndices.length > 0 ? Math.min(...markerIndices) : -1;
		const baseText = firstMarkerIndex >= 0 ? text.slice(0, firstMarkerIndex) : text;
		return baseText
			.split('\n')
			.map(line => line.trim())
			.filter(line => line && !line.startsWith('Mount:') && !line.startsWith('Path:'))
			.join(' ');
	}

	private getVisibleBackgroundColor(el: HTMLElement): string | null {
		const candidates = [
			el,
			...Array.from(el.querySelectorAll<HTMLElement>('*')),
		];

		for (const candidate of candidates) {
			const backgroundColor = window.getComputedStyle(candidate).backgroundColor;
			if (
				backgroundColor &&
				backgroundColor !== 'transparent' &&
				!backgroundColor.endsWith(', 0)') &&
				backgroundColor !== 'rgba(0, 0, 0, 0)'
			) {
				return backgroundColor;
			}
		}

		return null;
	}

	private removeMountInfoFromNativeTooltips(): void {
		document.querySelectorAll<HTMLElement>('.folderbridge-tooltip-container-augmented').forEach(el => {
			el.removeClass('folderbridge-tooltip-container-augmented');
			el.style.removeProperty('background-color');
			el.style.removeProperty('color');
		});
		document.querySelectorAll<HTMLElement>('.folderbridge-tooltip-augmented').forEach(el => {
			const originalText = el.dataset.folderbridgeOriginalText;
			if (originalText !== undefined) {
				el.replaceWith(document.createTextNode(originalText));
			} else {
				el.remove();
			}
		});
	}

	private setExplorerMountMetadata(el: HTMLElement, mount: MountPoint, typeLabel: string): void {
		const label = mount.label ? ` (${mount.label})` : '';
		const source = !mount.mountType || mount.mountType === 'local' || mount.mountType === 'vault'
			? this.pathMapper.getEffectiveRealPath(mount) : mount.realPath;
		el.dataset.folderbridgeMountTooltip = [
			`Mount: ${typeLabel}${label}`,
			`Path: ${source}`,
		].join('\n');
	}

	private clearExplorerMountMetadata(el: HTMLElement): void {
		delete el.dataset.folderbridgeMountTooltip;
	}

	/**
	 * Walk the file-explorer DOM and add CSS classes to tree items whose
	 * path belongs to a mount point.  Also sets a tooltip with mount source
	 * details on the root folder of each mount.
	 */
	private highlightMountedInExplorer(): void {
		// If global highlight is disabled — do nothing
		if (!this.settings.enableExplorerHighlight) {
			return;
		}

		const leaves = this.app.workspace.getLeavesOfType('file-explorer');
		if (!leaves.length) return;

		const explorerEl = leaves[0].view.containerEl;

		// Collect mount paths for fast lookup
		const activeMounts = this.settings.mountPoints.filter(m => m.enabled && this.isMountEnabledOnThisDevice(m));
		const mountPaths = new Set(activeMounts.map(m => normalizePath(m.virtualPath)));
		// Map: path -> MountPoint for tooltip and type-specific styling
		const mountMap = new Map<string, MountPoint>();
		for (const m of activeMounts) {
			mountMap.set(normalizePath(m.virtualPath), m);
		}

		const mountTypeLabel: Record<string, string> = {
			local: 'Local folder',
			vault: 'External vault',
			webdav: 'WebDAV',
			s3: 'S3',
			sftp: 'SFTP',
		};

		// Process folder items
		explorerEl.querySelectorAll<HTMLElement>('.nav-folder-title').forEach(el => {
			const dataPath = el.getAttribute('data-path');
			if (!dataPath) return;
			const normalized = normalizePath(dataPath);

			if (mountPaths.has(normalized)) {
				// This is the mount root folder
				el.classList.add('folderbridge-mounted');
				const mount = mountMap.get(normalized);
				const mountType = mount?.mountType ?? 'local';
				el.setAttribute('data-folderbridge-mount-type', mountType);

				if (mount) {
					const typeLabel = mountTypeLabel[mountType] ?? mountType;
					this.setExplorerMountMetadata(el, mount, typeLabel);
				}
			} else {
				el.classList.remove('folderbridge-mounted');
				el.removeAttribute('data-folderbridge-mount-type');
				this.clearExplorerMountMetadata(el);
			}

			// Check if this folder is a child of a mounted folder
			const isChild = [...mountPaths].some(mp => normalized.startsWith(mp + '/'));
			if (isChild) {
				el.classList.add('folderbridge-mounted-child');
			} else {
				el.classList.remove('folderbridge-mounted-child');
			}
		});

		// Process files — apply color highlight based on mount
		explorerEl.querySelectorAll<HTMLElement>('.nav-file-title').forEach(el => {
			const dataPath = el.getAttribute('data-path');
			if (!dataPath) return;
			const normalized = normalizePath(dataPath);

			const isInMount = [...mountPaths].some(mp => normalized.startsWith(mp + '/'));
			if (isInMount) {
				el.classList.add('folderbridge-mounted-child');

				// Get the effective mount — checks real filesystem existence, not just virtual path
				const mount = this.virtualAdapter?.getEffectiveMountForExplorer(normalized);
				if (mount) {
					const color = (mount as MountPoint).highlightColor;
					if (color && color.trim() !== '') {
						el.classList.add('folderbridge-highlighted');
						el.style.setProperty('--highlight-color', color);
					} else {
						el.classList.remove('folderbridge-highlighted');
						el.style.removeProperty('--highlight-color');
					}
				} else {
					// File belongs to local vault — no highlight
					el.classList.remove('folderbridge-highlighted');
					el.style.removeProperty('--highlight-color');
				}
			} else {
				el.classList.remove('folderbridge-mounted-child', 'folderbridge-highlighted');
				el.removeAttribute('data-folderbridge-mount-type');
				el.style.removeProperty('--highlight-color');
			}
		});
	}

	private ignoreCache = new Map<string, { nameStrings: string[], pathStrings: string[], regexes: RegExp[] }>();

	/** Public alias used by the settings UI to refresh after global-pattern changes. */
	updateIgnoreCachePublic() { this.updateIgnoreCache(); }

	private updateIgnoreCache() {
		this.ignoreCache.clear();

		// Pre-parse global patterns once
		const globalList = this.settings.globalIgnorePatterns || [];
		const globalNameStrings: string[] = [];
		const globalPathStrings: string[] = [];
		const globalRegexes: RegExp[] = [];
		for (const pattern of globalList) {
			if (pattern.includes('*')) {
				const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
				globalRegexes.push(new RegExp('^' + escaped.replace(/\*/g, '[^/]*') + '$'));
			} else if (pattern.includes('/')) {
				globalPathStrings.push(normalizePath(pattern));
			} else {
				globalNameStrings.push(pattern);
			}
		}

		for (const mount of this.settings.mountPoints) {
			const nameStrings: string[] = [...globalNameStrings];
			const pathStrings: string[] = [...globalPathStrings];
			const regexes: RegExp[] = [...globalRegexes];
			const list = mount.ignoreList || [];
			for (const pattern of list) {
				if (pattern.includes('*')) {
					// Use [^/]* instead of .* to prevent ReDoS from user-supplied
					// patterns like "a*b*" which would produce catastrophic backtracking
					const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
					const regexStr = '^' + escaped.replace(/\*/g, '[^/]*') + '$';
					regexes.push(new RegExp(regexStr));
				} else if (pattern.includes('/')) {
					pathStrings.push(normalizePath(pattern));
				} else {
					nameStrings.push(pattern);
				}
			}
			this.ignoreCache.set(mount.id, { nameStrings, pathStrings, regexes });
		}
	}

	/**
	 * Returns true when `name` (the leaf filename/dirname) or `mountRelativePath`
	 * (the path relative to the mount root, e.g. "assets/vendor/cache") should
	 * be excluded from the vault view and file watcher.
	 *
	 * Pattern types in ignoreList:
	 *   - No slash, no wildcard  → matched against the leaf name only
	 *     (e.g. ".git", "node_modules")
	 *   - Contains "/"           → matched as a prefix against mountRelativePath
	 *     (e.g. "assets/vendor" ignores that subtree and nothing else named "assets")
	 *   - Contains "*"           → treated as a glob matched against the leaf name
	 *     (e.g. "*.tmp", "~$*")
	 */
	isNameIgnored(name: string, mount: MountPoint, mountRelativePath?: string): boolean {
		const cache = this.ignoreCache.get(mount.id);
		if (!cache) return false;
		// Path-prefix patterns: only applicable when the full relative path is known
		if (mountRelativePath) {
			for (const pathPat of cache.pathStrings) {
				if (mountRelativePath === pathPat || mountRelativePath.startsWith(pathPat + '/')) return true;
			}
		}
		// Name patterns and globs
		if (cache.nameStrings.includes(name)) return true;
		for (const regex of cache.regexes) {
			if (regex.test(name)) return true;
		}
		return false;
	}

	// ------------------------------------------------------------------
	// Adapter installation
	// ------------------------------------------------------------------

	private installVirtualAdapter(): void {
		const vault = this.app.vault as typeof this.app.vault & VaultInternal;
		this.originalAdapter = vault.adapter;

		this.virtualAdapter = new VirtualAdapter(
			this.originalAdapter,
			this.pathMapper,
			this.security,
			this.settings.dryRun,
			(this.settings.maxDataUriMB ?? 10) * 1024 * 1024,
			async (mount: MountPoint) => {
				let action: 'unmount' | 'delete' | 'cancel' = 'cancel';

				if (this.settings.mountRootDeletionBehavior === 'unmount') {
					action = 'unmount';
				} else if (this.settings.mountRootDeletionBehavior === 'delete') {
					action = 'delete';
				} else {
					action = await new Promise<'unmount' | 'delete' | 'cancel'>((resolve) => {
						const modal = new MountRootDeleteModal(this.app, mount.virtualPath, async (result) => {
							if (result === 'unmount-always') {
								this.settings.mountRootDeletionBehavior = 'unmount';
								await this.saveSettings();
								resolve('unmount');
							} else if (result === 'delete-always') {
								this.settings.mountRootDeletionBehavior = 'delete';
								await this.saveSettings();
								resolve('delete');
							} else {
								resolve(result);
							}
						});
						modal.open();
					});
				}

				if (action === 'unmount') {
					const idx = this.persistedMountPoints.findIndex(m => m.id === mount.id);
					if (idx !== -1) {
						this.persistedMountPoints.splice(idx, 1);
						await this.saveSettings();
						this.syncEffectiveMountState();
						this.updateStatusBar();
					}
				}

				return action;
			},
			// onMountRootMove: called when the user drags/moves a mount root in the file explorer
			async (mount: MountPoint, newVirtualPath: string) => {
				await this.updateMount(mount.id, { ...mount, virtualPath: newVirtualPath });
			},
			(name: string, mount: MountPoint, mountRelativePath?: string) => {
				return this.isNameIgnored(name, mount, mountRelativePath);
			},
			// onModify: fired after every successful write/append on a mounted path.
			//
			// Obsidian's own file-system watcher only monitors the vault directory, so
			// it never fires vault.onChange('raw', …) for writes to external mount paths.
			// FolderBridge's Chokidar watcher covers external changes from other apps,
			// but on Windows network/mapped drives (SMB) native ReadDirectoryChangesW
			// events often don't propagate — so Chokidar misses writes that originate
			// inside Obsidian too (e.g. Bases editing frontmatter).  The net effect is
			// that MetadataCache stays stale and features like Bases never update their
			// views after a frontmatter edit until the plugin is toggled or Obsidian is
			// restarted.
			//
			// Firing 'modified' + 'raw' here is the same thing FileWatcher does for
			// externally-detected changes, and mirrors the vault.create() patch above.
			// If Chokidar also fires for the same write (on drives that DO support native
			// events) the double notification is harmless — MetadataCache re-reads the
			// file twice and emits 'changed' once.
			async (normalizedPath: string) => {
				const mountForPath = this.pathMapper.getMountForPath(normalizedPath);
				if (!mountForPath) return;
				// Respect per-mount and runtime suppression flags.
				if (this.fileWatcher?.isSuppressed(mountForPath.id) || mountForPath.watcherSuppressAllEvents) return;
				const vault = this.app.vault as typeof this.app.vault & VaultInternal;
				if (typeof vault.onChange !== 'function') return;
				try {
					const stat = await this.app.vault.adapter.stat(normalizedPath);
					if (stat) {
						// 'modified' (not 'file-changed', which Vault.onChange ignores) so
						// Obsidian invalidates the file content cache and re-parses metadata.
						await vault.onChange('modified', normalizedPath, null, stat);
						await vault.onChange('raw', normalizedPath, null, null);
					}
				} catch {
					// Best-effort: stat may fail transiently (e.g. cloud mount); ignore.
				}
			},
			// onDelete: fired after a mounted path is deleted via the adapter.
			//
			// When a delete originates inside Obsidian, the external watcher may not
			// fire at all (watcher backend unavailable, network-drive watcher gaps,
			// or runtime suppression). Explicitly signaling the removal here keeps the
			// vault tree and any open file state in sync with the real filesystem.
			async (normalizedPath: string) => {
				const vault = this.app.vault as typeof this.app.vault & VaultInternal;
				if (typeof vault.onChange !== 'function') return;
				const existing = this.app.vault.getAbstractFileByPath(normalizedPath);
				if (!existing) return;
				await vault.onChange(existing instanceof TFolder ? 'folder-removed' : 'file-removed', normalizedPath, null, null);
			},
			// onRename: fired after a file/folder is renamed via the adapter.
			//
			// adapter.rename() performs the physical rename on disk, but Obsidian's
			// internal vault tree (TFile index) is not automatically updated for
			// newly-created files that may not be fully registered yet. Firing
			// 'rename' here tells Obsidian to update the in-memory tree so the
			// explorer shows the new name immediately.
			async (oldPath: string, newPath: string) => {
				const vault = this.app.vault as typeof this.app.vault & VaultInternal;
				if (typeof vault.onChange !== 'function') return;
				const existing = this.app.vault.getAbstractFileByPath(oldPath);
				if (!existing) return;
				await (vault.onChange as (event: string, path: string, prev: unknown, stat: unknown) => Promise<void>)('rename', oldPath, newPath, null);
			}
		);

		// Wrap with a Proxy so that any undocumented methods on the original
		// adapter (internal Obsidian APIs) still work transparently.
		vault.adapter = new Proxy(this.virtualAdapter, {
			get(target, prop, receiver) {
				// If VirtualAdapter has the property, use it
				if (prop in target) {
					const val = Reflect.get(target, prop, receiver) as unknown;
					if (typeof val === 'function') {
						// eslint-disable-next-line @typescript-eslint/no-unsafe-return
						return (val as () => void).bind(target);
					}
					return val;
				}
				// Otherwise fall through to the original adapter
				const orig = (target as unknown as { orig?(): DataAdapter }).orig?.();
				if (orig && prop in orig) {
					const val = orig[prop as keyof typeof orig] as unknown;
					if (typeof val === 'function') {
						// eslint-disable-next-line @typescript-eslint/no-unsafe-return
						return (val as () => void).bind(orig);
					}
					return val;
				}
				return undefined;
			},
			// Present the original adapter's prototype to satisfy Obsidian's internal
			// `instanceof FileSystemAdapter` guards.  Several desktop-only paths —
			// most visibly the CSS Snippets "open folder" button in Appearance settings
			// — bail out silently when this check fails.  Because our proxy wraps the
			// original FileSystemAdapter and fully delegates all unimplemented methods
			// back to it, reporting its prototype is semantically accurate.
			getPrototypeOf(target) {
				const origProvider = target as unknown as { orig?: () => DataAdapter };
				const orig = origProvider.orig?.();
				// eslint-disable-next-line @typescript-eslint/no-unsafe-return
				return orig ? Object.getPrototypeOf(orig) : Object.getPrototypeOf(target);
			},
		}) as unknown as DataAdapter;

		// Obsidian's renderer calls Vault.getResourcePath(TFile) directly — it does NOT
		// go through the adapter. We must also patch the vault-level method so that
		// embedded images in mounted folders resolve to the real disk path.
		this.originalVaultGetResourcePath = vault.getResourcePath?.bind(vault);
		const pathMapper = this.pathMapper;
					vault.getResourcePath = (file: TFile): string => {
				const mount = pathMapper.getMountForPath(file.path);
				if (mount) {
					const mountRealPath = pathMapper.toRealPath(file.path, mount);
					let existsInMount = false;
					if (!['webdav', 's3', 'sftp'].includes(mount.mountType ?? '')) {
						try { existsInMount = fs.existsSync(mountRealPath); } catch { /* ignore */ }
					} else {
						existsInMount = true; // cloud mounts are authoritative
					}

					if (existsInMount) {
						// Файл реально есть в маунте, используем его
						return this.virtualAdapter?.resolveResourceUrl(mountRealPath)
							?? tryReadAsDataUri(mountRealPath, (this.settings.maxDataUriMB ?? 10) * 1024 * 1024)
							?? realPathToResourceUrl(mountRealPath);
					}

					// [CRITICAL FIX] Файла НЕТ в маунте. Он принадлежит основному хранилищу.
					// Не используем originalVaultGetResourcePath, так как кэш Obsidian может 
					// ошибочно связывать этот file.path с маунтом. Вместо этого явно вычисляем 
					// локальный путь и генерируем URL из него.
					logger.debug(`[FolderBridge] getResourcePath() forcing local vault path for: "${file.path}"`);
					const adapter = this.app.vault.adapter as any;
					const basePath = typeof adapter.getBasePath === 'function' ? adapter.getBasePath() : '';
					const localRealPath = path.join(basePath, file.path.replace(/\//g, path.sep));

					return this.virtualAdapter?.resolveResourceUrl(localRealPath)
						?? tryReadAsDataUri(localRealPath, (this.settings.maxDataUriMB ?? 10) * 1024 * 1024)
						?? realPathToResourceUrl(localRealPath);
				}

				// Fallback для файлов, которые вообще не подпадают под маунты
				if (typeof this.originalVaultGetResourcePath === 'function') {
					return (this.originalVaultGetResourcePath as (file: TFile) => string)(file);
				}
				return '';
			};

		// Patch app.openWithDefaultApp() to use the real filesystem path for
		// mounted files.  Without this, Obsidian constructs a path relative to
		// the vault root which doesn't exist on disk for external mounts, so the
		// "Open with default application" context-menu action silently does nothing.
		const appInternal = this.app as App & AppInternal;
		this.originalOpenWithDefaultApp = appInternal.openWithDefaultApp?.bind(this.app);
		appInternal.openWithDefaultApp = (filePath: string): void => {
			const nPath = normalizePath(filePath);
			const mount = pathMapper.getMountForPath(nPath);
			if (mount && !['webdav', 's3', 'sftp'].includes(mount.mountType ?? '')) {
				// Local mount: pass the real OS path directly to the shell
				const realPath = pathMapper.toRealPath(nPath, mount);
				// [BUGFIX] Check if file actually exists in mount before using mount path.
				// When a root mount covers all paths, primary vault files would
				// resolve to the mount's path where they don't exist.
				let existsInMount = false;
				try { existsInMount = fs.existsSync(realPath); } catch { /* ignore */ }
				if (existsInMount) {
					try {
						const electron = loadOptionalNodeModule<ElectronModule>('electron');
						const shellApi: ElectronShell | undefined = electron?.shell ?? electron?.default?.shell;
						shellApi?.openPath(realPath).catch((e: unknown) => {
							logger.warn('[Folder Bridge] openWithDefaultApp shell.openPath failed:', e);
						});
					} catch (e) {
						logger.warn('[Folder Bridge] openWithDefaultApp: electron not available', e);
					}
					return;
				}
				logger.debug(`[FolderBridge] openWithDefaultApp() file not in mount, fallback: "${filePath}"`);
			}
			// Non-mounted or cloud file: fall through to original
			if (typeof this.originalOpenWithDefaultApp === 'function') {
				(this.originalOpenWithDefaultApp as (f: string) => void)(filePath);
			}
		};

		// Patch vault.create() and vault.createBinary() for virtual mount paths.
		//
		// Obsidian's internal vault.create() calls adapter.getFullPath() to verify
		// that the parent directory exists on the local filesystem before — and after
		// — writing.  For virtual mount files the real data lives in the mounted
		// source directory, not inside the vault's physical folder.  Even with
		// getFullPath() correctly overridden on the adapter, Obsidian may not call
		// vault.onChange('file-created', …) synchronously for virtual paths (it
		// relies on the native filesystem watcher, which only watches the vault dir).
		//
		// This patch ensures that, for any path belonging to a virtual mount:
		// 1. The original vault.create() runs normally (it writes via our adapter).
		// 2. If the TFile is not in the vault's fileMap after that call, we perform
		//    a manual write + immediate vault.onChange('file-created', …) so the TFile
		//    is present and a newly-opened tab immediately shows the new note.
		// Save the original vault adapter BEFORE patching vault.create
		this.originalVaultAdapter = vault.adapter;
		this.originalVaultCreate = vault.create?.bind(vault);
		this.originalVaultCreateBinary = vault.createBinary?.bind(vault);

		type OrigVaultCreate = (path: string, data: string, options?: unknown) => Promise<TFile | null>;
		type OrigVaultCreateBinary = (path: string, data: ArrayBuffer, options?: unknown) => Promise<TFile | null>;
		type PatchedVault = { create?: OrigVaultCreate; createBinary?: OrigVaultCreateBinary };

		(vault as unknown as PatchedVault).create = async (path: string, data: string, options?: unknown): Promise<TFile | null> => {
			const nPath = normalizePath(path);
			const srcMount = this.pathMapper.getMountForPath(nPath);

			// If the path belongs to a mount, check if we should redirect to defaultCreationVault
			let finalPath = nPath;
			let isVaultRedirect = false;
			const defaultVault = this.settings.defaultCreationVault ?? 'vault';
			if (srcMount) {
				if (defaultVault === 'vault') {
					// Redirect to local vault — keep the full virtual path as-is
					// The local vault has the same folder structure as the virtual path
					// (e.g. virtual "Хранилище 0/Заметки/..." → local "Хранилище 0/Заметки/...")
					finalPath = nPath;
					isVaultRedirect = true;
				} else if (defaultVault === 'mounts') {
					// Create in the mount with highest priority — let the existing priority system handle it
					// No redirect needed, just use the original path
				}
				// Legacy: if defaultVault is a specific mount id, redirect to that mount
				// (kept for backward compatibility)
			}

			// Handle vault redirection (path may be unchanged)
			if (isVaultRedirect) {
				// Create in the redirected path (local vault)
				// Ensure parent directory exists (Obsidian requires it)
				const parentDir = finalPath.substring(0, finalPath.lastIndexOf('/'));
				if (parentDir && !await vault.adapter.exists(parentDir)) {
					try {
						await vault.adapter.mkdir(parentDir);
					} catch {
						// Directory may already exist or be read-only
					}
				}

				// For vault redirection, use original adapter directly (not VirtualAdapter)
				const origAdapter = (this.virtualAdapter as any).orig?.();
				if (origAdapter) {
					try {
						await origAdapter.write(finalPath, data, options as DataWriteOptions | undefined);
					} catch {
						// File may already have been written
					}
				} else {
					// Fallback: use vault.adapter (may route through mounts)
					try {
						await vault.adapter.write(finalPath, data, options as DataWriteOptions | undefined);
					} catch {
						// File may already have been written
					}
				}
				// Register the file with Obsidian and open it
				const stat = await vault.adapter.stat(finalPath);
				if (stat && typeof vault.onChange === 'function') {
					await vault.onChange('file-created', normalizePath(finalPath), null, stat);
				}
				const created = this.app.vault.getAbstractFileByPath(normalizePath(finalPath));
				if (created instanceof TFile) {
					// Open the file in a new tab
					await this.app.workspace.openLinkText(normalizePath(finalPath), normalizePath(finalPath), 'split');
					return created;
				}
				return null;
			}

			if (finalPath !== nPath) {
				// Create in the redirected mount path
				// Ensure parent directory exists (Obsidian requires it)
				const parentDir = finalPath.substring(0, finalPath.lastIndexOf('/'));
				if (parentDir && !await vault.adapter.exists(parentDir)) {
					try {
						await vault.adapter.mkdir(parentDir);
					} catch {
						// Directory may already exist or be read-only
					}
				}

				// For mount redirection, use originalVaultCreate
				const result = await (this.originalVaultCreate as OrigVaultCreate)(finalPath, data, options);
				if (result) return result;

				// Update tree
				const existing = this.app.vault.getAbstractFileByPath(normalizePath(finalPath));
				if (existing instanceof TFile) return existing;
				const stat = await vault.adapter.stat(finalPath);
				if (stat && typeof vault.onChange === 'function' && !this.app.vault.getAbstractFileByPath(normalizePath(finalPath))) {
					await vault.onChange('file-created', normalizePath(finalPath), null, stat);
				}
				const created = this.app.vault.getAbstractFileByPath(normalizePath(finalPath));
				return created instanceof TFile ? created : null;
			}

			if (!srcMount) {
				return (this.originalVaultCreate as OrigVaultCreate)(path, data, options);
			}

			// Let the original vault.create() run — it calls adapter.write() and may
			// call vault.onChange('file-created', …) depending on the Obsidian version.
			try {
				await (this.originalVaultCreate as OrigVaultCreate)(path, data, options);
			} catch (e) {
				// Original vault.create() might reject due to a failed filesystem check
				// against the vault physical directory (the real file is in the mount).
				// We swallow the error and fall through to manual registration.
				logger.debug('[Folder Bridge] vault.create() rejected for virtual path, using manual registration:', e);
			}

			// If the original call already registered the TFile, return it.
			const existingA = this.app.vault.getAbstractFileByPath(nPath);
			const existing = existingA instanceof TFile ? existingA : null;
			if (existing) return existing;

			// Manual fallback: write the file + register the TFile immediately.
			// This runs when vault.create() failed or when Obsidian relies on the
			// native FS watcher (which never fires for paths outside the vault dir).
			try {
				await vault.adapter.write(nPath, data, options as DataWriteOptions | undefined);
			} catch {
				// File may already have been written by the failed vault.create() above.
			}
			const stat = await vault.adapter.stat(nPath);
			if (stat && typeof vault.onChange === 'function' && !this.app.vault.getAbstractFileByPath(nPath)) {
				await vault.onChange('file-created', nPath, null, stat);
			}
			const created = this.app.vault.getAbstractFileByPath(nPath);
			return created instanceof TFile ? created : null;
		};

		(vault as unknown as PatchedVault).createBinary = async (path: string, data: ArrayBuffer, options?: unknown): Promise<TFile | null> => {
			const nPath = normalizePath(path);
			const srcMount = this.pathMapper.getMountForPath(nPath);

			// If the path belongs to a mount, check if we should redirect to defaultCreationVault
			let finalPath = nPath;
			let isVaultRedirect = false;
			const defaultVault = this.settings.defaultCreationVault ?? 'vault';
			if (srcMount) {
				if (defaultVault === 'vault') {
					// Redirect to local vault — keep the full virtual path as-is
					// The local vault has the same folder structure as the virtual path
					finalPath = nPath;
					isVaultRedirect = true;
				} else if (defaultVault === 'mounts') {
					// Create in the mount with highest priority — let the existing priority system handle it
					// No redirect needed, just use the original path
				}
				// Legacy: if defaultVault is a specific mount id, redirect to that mount
				// (kept for backward compatibility)
			}

			if (finalPath !== nPath) {
				// Create in the redirected path
				// Ensure parent directory exists (Obsidian requires it)
				const parentDir = finalPath.substring(0, finalPath.lastIndexOf('/'));
				if (parentDir && !await vault.adapter.exists(parentDir)) {
					try {
						await vault.adapter.mkdir(parentDir);
					} catch {
						// Directory may already exist or be read-only
					}
				}

				if (isVaultRedirect && this.virtualAdapter) {
					// For vault redirection, use original adapter directly (not VirtualAdapter)
					const origAdapter = (this.virtualAdapter as any).orig?.();
					if (origAdapter) {
						try {
							await origAdapter.writeBinary(finalPath, data, options as DataWriteOptions | undefined);
						} catch {
							// File may already have been written
						}
					} else {
						// Fallback: use vault.adapter (may route through mounts)
						try {
							await vault.adapter.writeBinary(finalPath, data, options as DataWriteOptions | undefined);
						} catch {
							// File may already have been written
						}
					}
					// Register the file with Obsidian and open it
					const stat = await vault.adapter.stat(finalPath);
					if (stat && typeof vault.onChange === 'function') {
						await vault.onChange('file-created', normalizePath(finalPath), null, stat);
					}
					const created = this.app.vault.getAbstractFileByPath(normalizePath(finalPath));
					if (created instanceof TFile) {
						// Open the file in a new tab
						await this.app.workspace.openLinkText(normalizePath(finalPath), normalizePath(finalPath), 'split');
						return created;
					}
					return null;
				} else {
					// For mount redirection, use originalVaultCreateBinary
					const result = await (this.originalVaultCreateBinary as OrigVaultCreateBinary)(finalPath, data, options);
					if (result) return result;
				}

				// Update tree
				const existing = this.app.vault.getAbstractFileByPath(normalizePath(finalPath));
				if (existing instanceof TFile) return existing;
				const stat = await vault.adapter.stat(finalPath);
				if (stat && typeof vault.onChange === 'function' && !this.app.vault.getAbstractFileByPath(normalizePath(finalPath))) {
					await vault.onChange('file-created', normalizePath(finalPath), null, stat);
				}
				const created = this.app.vault.getAbstractFileByPath(normalizePath(finalPath));
				return created instanceof TFile ? created : null;
			}

			if (!srcMount) {
				return (this.originalVaultCreateBinary as OrigVaultCreateBinary)(path, data, options);
			}

			try {
				await (this.originalVaultCreateBinary as OrigVaultCreateBinary)(path, data, options);
			} catch (e) {
				logger.debug('[Folder Bridge] vault.createBinary() rejected for virtual path, using manual registration:', e);
			}

			const existingBin = this.app.vault.getAbstractFileByPath(nPath);
			const existing = existingBin instanceof TFile ? existingBin : null;
			if (existing) return existing;

			try {
				await vault.adapter.writeBinary(nPath, data, options as DataWriteOptions | undefined);
			} catch {
				// File may already have been written by the failed vault.createBinary().
			}
			const stat = await vault.adapter.stat(nPath);
			if (stat && typeof vault.onChange === 'function' && !this.app.vault.getAbstractFileByPath(nPath)) {
				await vault.onChange('file-created', nPath, null, stat);
			}
			const createdBin = this.app.vault.getAbstractFileByPath(nPath);
			return createdBin instanceof TFile ? createdBin : null;
		};
	}

	// ------------------------------------------------------------------
	// Mount management
	// ------------------------------------------------------------------

	async addMount(mountData: Omit<MountPoint, 'id'>): Promise<void> {
		await this.waitForManagedTocResolution();
		const mountType = (mountData as MountPoint).mountType;
		const isCloud = mountType === 'webdav' || mountType === 's3' || mountType === 'sftp';
		const existingMounts = this.settings.mountPoints;

		// Validate against existing mounts; cloud mounts skip local-path validation
		const error = this.security.validateMount(mountData, existingMounts);
		if (error) {
			new Notice(i18n.t('notice.generic', { message: error }));
			return;
		}
		if (!isCloud) {
			// Surface advisory warnings (UNC paths, real-path overlaps) for local mounts
			const warnings = this.security.getPathWarnings(mountData.realPath, existingMounts, mountType);
			for (const w of warnings) {
				new Notice(i18n.t('notice.warning', { message: w }), 10_000);
			}
		}

		// Strip ALL transient credential fields before persisting to data.json
		const {
			webdavPassword,
			s3SecretKey,
			sftpPassword,
			sftpPassphrase,
			...mountDataClean
		} = mountData as MountPoint;

		const mount: MountPoint = {
			...mountDataClean,
			id: generateId(),
			deviceId: this.settings.deviceId,
			// Vault mounts get a broader default ignore list
			ignoreList: mountDataClean.mountType === 'vault'
				? ['.git', 'node_modules', this.app.vault.configDir, '.trash', '.smart-connections']
				: ['.git', 'node_modules', this.app.vault.configDir]
		};

		if (this.canPersistToManagedToc(mount.mountType)) {
			if (!await this.writeManagedTocMounts([...this.getManagedTocDraftMounts(), mount])) {
				return;
			}
			await this.refreshTocMountSources(true);
		} else {
			this.persistedMountPoints.push(mount);
		}

		// Register in allowlist (local mounts only — cloud mounts have no local path)
		if (!isCloud && !this.canPersistToManagedToc(mount.mountType) && !this.persistedAllowlist.includes(mount.realPath)) {
			this.persistedAllowlist.push(mount.realPath);
			this.security.allow(mount.realPath);
		}
		if (!isCloud && mount.fallbackRealPath && !this.persistedAllowlist.includes(mount.fallbackRealPath)) {
			this.persistedAllowlist.push(mount.fallbackRealPath);
			this.security.allow(mount.fallbackRealPath);
		}

		// Wire up WebDAV adapter
		if (mount.mountType === 'webdav') {
			if (webdavPassword) {
				saveWebDAVPassword(mount.id, webdavPassword);
				const encrypted = encryptCredential(webdavPassword);
				if (encrypted) {
					mount.encryptedWebdavPassword = encrypted;
					await this.saveSettings();
				}
			}
			const adapter = WebDAVAdapter.fromMount(mount);
			if (adapter) this.virtualAdapter?.setWebDAVAdapter(mount.id, adapter);
		}

		// Wire up S3 adapter
		if (mount.mountType === 's3') {
			if (s3SecretKey) {
				saveSessionCredential('s3', mount.id, s3SecretKey);
				const encrypted = encryptCredential(s3SecretKey);
				if (encrypted) {
					mount.encryptedS3SecretKey = encrypted;
					await this.saveSettings();
				}
			}
			const s3 = S3Adapter.fromMount(mount);
			if (s3) this.virtualAdapter?.setS3Adapter(mount.id, s3);
		}

		// Wire up SFTP adapter
		if (mount.mountType === 'sftp') {
			if (sftpPassword) {
				saveSessionCredential('sftp-pw', mount.id, sftpPassword);
				const encrypted = encryptCredential(sftpPassword);
				if (encrypted) {
					mount.encryptedSftpPassword = encrypted;
					await this.saveSettings();
				}
			}
			if (sftpPassphrase) {
				saveSessionCredential('sftp-pp', mount.id, sftpPassphrase);
				const encrypted = encryptCredential(sftpPassphrase);
				if (encrypted) {
					mount.encryptedSftpPassphrase = encrypted;
					await this.saveSettings();
				}
			}
			const sftpAdapter = SFTPAdapter.fromMount(mount);
			if (sftpAdapter) this.virtualAdapter?.setSFTPAdapter(mount.id, sftpAdapter);
		}

		await this.saveSettings();
		this.syncEffectiveMountState();
		this.updateStatusBar();
		const runtimeMount = this.settings.mountPoints.find(existing => existing.id === mount.id) ?? mount;

		// Register the mount's real path with the streaming server (local mounts only)
		if (!isCloud && runtimeMount.realPath) this.fileServer.addAllowedPath(runtimeMount.realPath);
		if (!isCloud && runtimeMount.fallbackRealPath) this.fileServer.addAllowedPath(runtimeMount.fallbackRealPath);

		backgroundTask(this.notifyVaultMountAdded(runtimeMount), `Failed to inject newly-added mount "${runtimeMount.virtualPath}" into the vault tree.`);

		let mountLabel: string;
		if (runtimeMount.mountType === 'webdav') {
			mountLabel = `"${runtimeMount.webdavUrl}" → "${runtimeMount.virtualPath}"`;
		} else if (runtimeMount.mountType === 's3') {
			mountLabel = `s3://${runtimeMount.s3Bucket}${runtimeMount.realPath} → "${runtimeMount.virtualPath}"`;
		} else if (runtimeMount.mountType === 'sftp') {
			mountLabel = `sftp://${runtimeMount.sftpHost}${runtimeMount.realPath} → "${runtimeMount.virtualPath}"`;
		} else {
			mountLabel = `"${runtimeMount.realPath}" → "${runtimeMount.virtualPath}"`;
		}
		new Notice(i18n.t('status.mounted.label', { mount: mountLabel }));
		// Refresh tag-based commands after adding a new mount (may have new tags)
		this.refreshTagCommands();
	}

	/**
	 * Determine the storage type of a virtual path: vault or a specific mount.
	 * Checks physical existence, not virtual routing.
	 */
	private async resolveStorageType(virtualPath: string): Promise<'vault' | MountPoint> {
		logger.debug(`[FolderBridge] resolveStorageType: ${virtualPath}`);
		// Check if file physically exists in any mount
		const mounts = this.pathMapper.getMountsForPath(virtualPath);
		logger.debug(`[FolderBridge] resolveStorageType: found ${mounts.length} mounts for path`);
		
		for (const mount of mounts) {
			logger.debug(`[FolderBridge] resolveStorageType: checking mount ${mount.virtualPath}`);
			if (VirtualAdapter.isCloudMount(mount)) {
				// For cloud mounts, use va.exists
				const va = this.virtualAdapter;
				if (va && await va.exists(virtualPath)) {
					logger.debug(`[FolderBridge] resolveStorageType: cloud mount has file, returning mount`);
					return mount;
				}
			} else {
				// Check physical existence in mount
				const realPath = this.pathMapper.toRealPath(virtualPath, mount);
				logger.debug(`[FolderBridge] resolveStorageType: checking real path: ${realPath}`);
				try {
					await fs.promises.access(realPath, fs.constants.F_OK);
					logger.debug(`[FolderBridge] resolveStorageType: file exists in mount ${mount.virtualPath}`);
					return mount;
				} catch {
					logger.debug(`[FolderBridge] resolveStorageType: file NOT in mount ${mount.virtualPath}`);
					// File doesn't exist in this mount
				}
			}
		}
		// Default: vault
		logger.debug(`[FolderBridge] resolveStorageType: not found in any mount, returning vault`);
		return 'vault';
	}

	/**
	 * Get the real filesystem path for a virtual path.
	 * Returns the vault base path if the file is in the vault,
	 * or the mount's real path if it's in a mount.
	 */
	private async resolveRealPath(virtualPath: string, storageType?: 'vault' | MountPoint): Promise<string> {
		// If storageType is not provided, determine it
		const st = storageType ?? await this.resolveStorageType(virtualPath);
		logger.debug(`[FolderBridge] resolveRealPath: ${virtualPath} -> storageType: ${typeof st === 'string' ? st : st.virtualPath}`);
		
		if (st === 'vault') {
			// Get vault base path
			const vaultAdapter = this.app.vault.adapter;
			const vaultAdapterTyped = vaultAdapter as { basePath?: string; adapter?: { getBasePath?: () => string } };
			const basePath = vaultAdapterTyped.basePath
				?? vaultAdapterTyped.adapter?.getBasePath?.()
				?? '';
			const realPath = path.join(basePath, virtualPath.replace(/\//g, path.sep));
			logger.debug(`[FolderBridge] resolveRealPath: vault real path: ${realPath}`);
			return realPath;
		} else {
			const realPath = this.pathMapper.toRealPath(virtualPath, st);
			logger.debug(`[FolderBridge] resolveRealPath: mount real path: ${realPath}`);
			return realPath;
		}
	}

	/**
	 * Recursively calculate folder size in KB using VirtualAdapter.
	 * Works regardless of whether files are in vault or mount.
	 */

	private async calculateFolderSize(va: VirtualAdapter, folderPath: string): Promise<number> {
		let totalBytes = 0;
		const MAX_ENTRIES = 100000;
		let count = 0;

		try {
			const listing = await va.list(folderPath);
			const allEntries = [...listing.files, ...listing.folders];

			for (const entry of allEntries) {
				if (count >= MAX_ENTRIES) break;
				count++;

				const entryPath = normalizePath(folderPath + '/' + entry);
				const stat = await va.stat(entryPath);

				if (stat) {
					if (stat.type === 'folder') {
						totalBytes += await this.calculateFolderSize(va, entryPath);
					} else {
						totalBytes += stat.size;
					}
				}
			}
		} catch {
			// Folder doesn't exist or can't be listed
		}

		return Math.ceil(totalBytes / 1024);
	}

	/**
	 * Recursively count files in a folder to know total conflicts upfront.
	 */
	private async countFiles(va: VirtualAdapter, folderPath: string): Promise<number> {
		let count = 0;
		try {
			const listing = await va.list(folderPath);
			const allEntries = [...listing.files, ...listing.folders];

			for (const entry of allEntries) {
				const entryPath = normalizePath(folderPath + '/' + entry);
				const stat = await va.stat(entryPath);
				if (stat && stat.type === 'folder') {
					count += await this.countFiles(va, entryPath);
				} else {
					count++;
				}
			}
		} catch {
			// Folder doesn't exist
		}
		return count;
	}

	// ------------------------------------------------------------------
	// Copy/Move context menu handler
	// ------------------------------------------------------------------

		async handleCopyMove(file: TAbstractFile, operation: 'copy' | 'move'): Promise<void> {
			// Show destination picker
			const onChoose = async (dest: import('./src/FileTransfer').DestinationOption) => {
				// Check if destination is reachable
				if (!dest.reachable) {
					new Notice(i18n.t('copy.dest.unreachable', { dest: dest.name }));
					return;
				}

				// Determine source mount
				const srcMount = this.pathMapper.getMountForPath(file.path);

				// Resolve destination mount
				let dstMount: MountPoint | null = null;
				if (dest.id !== 'vault') {
					dstMount = this.settings.mountPoints.find(m => m.id === dest.id && m.enabled) ?? null;
				}

				// Determine destination storage type based on selected destination (not physical existence)
				const dstStorageType: 'vault' | MountPoint = dest.id === 'vault' ? 'vault' : (dstMount ?? 'vault');
				logger.debug(`[FolderBridge] handleCopyMove: dstStorageType from dest.id=${dest.id}: ${typeof dstStorageType === 'string' ? dstStorageType : dstStorageType.virtualPath}`);

				// Calculate source size for large file warning using VirtualAdapter
				let sizeKB = 0;
				try {
					const va = this.virtualAdapter;
					if (va) {
						const stat = await va.stat(file.path);
						if (stat) {
							if (stat.type === 'folder') {
								// For folders, calculate total size recursively using VirtualAdapter
								sizeKB = await this.calculateFolderSize(va, file.path);
							} else {
								// For files, use stat.size directly
								sizeKB = Math.ceil(stat.size / 1024);
							}
						}
					}
				} catch {
					// Size calculation failed — proceed with 0
				}

				// Check large file warning for destination mount
				if (dstMount && dstMount.enableLargeFileConfirm && sizeKB > (dstMount.largeFileThresholdKB ?? 1024)) {
					const confirmed = await LargeFileWarningModal.show(
						this.app,
						file.name,
						sizeKB,
						dstMount,
						operation as 'create' | 'copy' | 'move',
						async (mount) => {
							await this.updateMount(mount.id, mount);
						},
					);
					if (!confirmed) return;
				}

				// Build destination virtual path (preserve source path structure)
				const dstVirtualPath = await this.buildDestinationVirtualPath(file, dest, srcMount);
				logger.debug(`[FolderBridge] handleCopyMove: file=${file.path}, operation=${operation}, dest=${dest.name}`);
				logger.debug(`[FolderBridge] handleCopyMove: dstVirtualPath=${dstVirtualPath}`);

				// Execute copy or move with conflict handling
				try {
					const va = this.virtualAdapter;
					if (!va) throw new Error('Folder Bridge: VirtualAdapter not initialized.');

					// Count total conflicts upfront
					let totalConflicts = 0;
					if (file instanceof TFolder) {
						totalConflicts = await this.countConflicts(va, file.path, dstVirtualPath, dstStorageType);
					} else {
						const dstRealPath = await this.resolveRealPath(dstVirtualPath, dstStorageType);
						try {
							await fs.promises.access(dstRealPath, fs.constants.F_OK);
							totalConflicts = 1;
						} catch {
							totalConflicts = 0;
						}
					}
					logger.debug(`[FolderBridge] handleCopyMove: totalConflicts=${totalConflicts}`);

					const conflictState = {
						skipAll: false,
						overwriteAll: false,
						totalConflicts,
						currentConflict: 0,
					};

					if (operation === 'copy') {
						await this.recursiveCopy(file.path, dstVirtualPath, file.path, dstVirtualPath, dstStorageType, conflictState);
						new Notice(i18n.t('copy.copied', { file: file.name, dest: dest.name }));
					} else {
						await this.recursiveMove(file.path, dstVirtualPath, file.path, dstVirtualPath, dstStorageType, conflictState);
						new Notice(i18n.t('move.moved', { file: file.name, dest: dest.name }));
					}

					// Refresh the vault tree
					await this.refreshTocMountSources(true);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					new Notice(i18n.t('copy.move.failed', {
						op: operation === 'copy' ? i18n.t('copy.op') : i18n.t('move.op'),
						message,
					}));
					logger.error(`[FolderBridge] ${operation} failed for "${file.path}":`, error);
				}
			};

			new DestinationPickerModal(this.app, this, file, operation, onChoose).open();
		}

		/**
		 * Count potential conflicts between source and destination paths.
		 * Checks physical existence using resolveStorageType and resolveRealPath.
		 */
		private async countConflicts(va: VirtualAdapter, srcPath: string, dstPath: string, dstStorageType?: 'vault' | MountPoint): Promise<number> {
			let count = 0;
			try {
				const stat = await va.stat(srcPath);
				if (stat && stat.type === 'folder') {
					const listing = await va.list(srcPath);
					const allEntries = [...listing.files, ...listing.folders];

					for (const entry of allEntries) {
						const entrySrcPath = normalizePath(srcPath + '/' + entry);
						const entryName = entry.split('/').pop()!.split('\\').pop()!;
						const entryDstPath = normalizePath(dstPath + '/' + entryName);

						const entryStat = await va.stat(entrySrcPath);
						if (entryStat && entryStat.type === 'folder') {
							count += await this.countConflicts(va, entrySrcPath, entryDstPath, dstStorageType);
						} else {
							// Check physical existence in destination
							const entryDstStorageType = dstStorageType;
							const dstRealPath = await this.resolveRealPath(entryDstPath, entryDstStorageType);
							try {
								await fs.promises.access(dstRealPath, fs.constants.F_OK);
								count++;
							} catch {
								// File doesn't physically exist
							}
						}
					}
				} else {
					// Check physical existence in destination
					const dstRealPath = await this.resolveRealPath(dstPath, dstStorageType);
					try {
						await fs.promises.access(dstRealPath, fs.constants.F_OK);
						count++;
					} catch {
						// File doesn't physically exist
					}
				}
			} catch {
				// Path doesn't exist
			}
			return count;
		}

		/**
		 * Build the destination virtual path preserving the source path structure.
		 * Preserves the full path from vault root, prepended with destination mount.
		 * E.g. "Хранилище 0/файл.pdf" → "_12/Хранилище 0/файл.pdf"
		 */
		private async buildDestinationVirtualPath(
			file: TAbstractFile,
			dest: import('./src/FileTransfer').DestinationOption,
			srcMount: MountPoint | undefined,
		): Promise<string> {
			logger.debug(`[FolderBridge] buildDestinationVirtualPath: file.path=${file.path}, dest.id=${dest.id}`);
			const mount = this.settings.mountPoints.find(m => m.id === dest.id && m.enabled);

			if (dest.id === 'vault') {
				// For vault destination, preserve the full path from vault root
				logger.debug(`[FolderBridge] buildDestinationVirtualPath: dest is vault, returning file.path as-is: ${file.path}`);
				return normalizePath(file.path);
			}

			if (!mount) return normalizePath(file.path);

			// Check if file is already inside the destination mount
			const destMountVirtual = normalizePath(mount.virtualPath);
			const fileNormalized = normalizePath(file.path);

			// If file is already inside the destination mount, preserve relative path from mount root
			if (fileNormalized.startsWith(destMountVirtual + '/') || fileNormalized === destMountVirtual) {
				const relPath = fileNormalized.startsWith(destMountVirtual + '/')
					? fileNormalized.slice(destMountVirtual.length + 1)
					: '';
				return relPath ? normalizePath(destMountVirtual + '/' + relPath) : destMountVirtual;
			}

			// File is outside the destination mount — preserve full path from vault root
			return normalizePath(destMountVirtual + '/' + file.path);
		}

		/**
		 * Recursively copy a file or folder from source to destination.
		 * Uses relative paths to avoid duplication in recursive calls.
		 * Handles conflicts when destination already exists.
		 */
		private async recursiveCopy(
			srcPath: string,
			dstPath: string,
			rootSrcPath: string,
			rootDstPath: string,
			dstStorageType: 'vault' | MountPoint,
			conflictState: { skipAll: boolean; overwriteAll: boolean; totalConflicts: number; currentConflict: number },
		): Promise<void> {
			const va = this.virtualAdapter;
			if (!va) throw new Error('Folder Bridge: VirtualAdapter not initialized.');

			// Resolve storage types and real paths for source and destination
			const srcStorageType = await this.resolveStorageType(srcPath);
			const srcRealPath = await this.resolveRealPath(srcPath);
			const dstRealPath = await this.resolveRealPath(dstPath, dstStorageType);

			logger.debug(`[FolderBridge] recursiveCopy: srcPath=${srcPath}, dstPath=${dstPath}`);
			logger.debug(`[FolderBridge] recursiveCopy: srcStorageType=${typeof srcStorageType === 'string' ? srcStorageType : srcStorageType.virtualPath}, dstStorageType=${typeof dstStorageType === 'string' ? dstStorageType : dstStorageType.virtualPath}`);
			logger.debug(`[FolderBridge] recursiveCopy: srcRealPath=${srcRealPath}, dstRealPath=${dstRealPath}`);

			// Check if destination exists and user wants to skip/overwrite
			if (!conflictState.skipAll) {
				let dstExists = false;
				try {
					logger.debug(`[FolderBridge] recursiveCopy: checking if dst exists: ${dstRealPath}`);
					await fs.promises.access(dstRealPath, fs.constants.F_OK);
					dstExists = true;
					logger.debug(`[FolderBridge] recursiveCopy: dst EXISTS`);
				} catch {
					dstExists = false;
					logger.debug(`[FolderBridge] recursiveCopy: dst does NOT exist`);
				}

				if (dstExists) {
					conflictState.currentConflict++;
					logger.debug(`[FolderBridge] recursiveCopy: CONFLICT #${conflictState.currentConflict}/${conflictState.totalConflicts}, showing dialog`);
					if (!conflictState.overwriteAll) {
						const resolution = await ConflictResolutionModal.show(
							this.app,
							dstPath.split('/').pop()!,
							'copy',
							conflictState.totalConflicts,
							conflictState.currentConflict - 1,
						);

						if (resolution === 'skip' || resolution === 'skipAll') {
							if (resolution === 'skipAll') conflictState.skipAll = true;
							logger.debug(`[FolderBridge] recursiveCopy: user chose ${resolution}, skipping`);
							return;
						}
						if (resolution === 'overwriteAll') conflictState.overwriteAll = true;
						logger.debug(`[FolderBridge] recursiveCopy: user chose ${resolution}, continuing`);
					}
				}
			}

			// Use stat to distinguish files from folders
			const stat = await va.stat(srcPath);
			logger.debug(`[FolderBridge] recursiveCopy: src is ${stat?.type}`);
			if (stat && stat.type === 'folder') {
				// Create destination folder
				logger.debug(`[FolderBridge] recursiveCopy: creating folder: ${dstRealPath}`);
				await fs.promises.mkdir(dstRealPath, { recursive: true });

				// List contents and copy each item
				const listing = await va.list(srcPath);
				const allEntries = [...listing.files, ...listing.folders];
				logger.debug(`[FolderBridge] recursiveCopy: folder has ${allEntries.length} entries`);

				for (const entry of allEntries) {
					// Extract just the filename from entry
					const entryName = entry.split('/').pop()!.split('\\').pop()!;
					const entrySrcPath = normalizePath(srcPath + '/' + entryName);
					// Calculate relative path from root source to get the relative destination
					const relPath = entrySrcPath.slice(rootSrcPath.length + 1);
					const entryDstPath = normalizePath(rootDstPath + '/' + relPath);
					logger.debug(`[FolderBridge] recursiveCopy: processing entry: ${entryName} -> ${entryDstPath}`);
					await this.recursiveCopy(entrySrcPath, entryDstPath, rootSrcPath, rootDstPath, dstStorageType, conflictState);
				}
			} else {
				// Copy file based on storage types
				logger.debug(`[FolderBridge] recursiveCopy: copying file, srcType===dstType: ${srcStorageType === dstStorageType}`);
				if (srcStorageType === dstStorageType) {
					// Same storage type — use appropriate copy method
					logger.debug(`[FolderBridge] recursiveCopy: using same-type copy`);
					if (srcStorageType === 'vault') {
						// Both in vault — use fs.copyFile with real paths
						// (va.copy() would try to route through mount which may not have the file)
						logger.debug(`[FolderBridge] recursiveCopy: vault->vault using fs.copyFile`);
						logger.debug(`[FolderBridge] recursiveCopy: srcRealPath=${srcRealPath}`);
						logger.debug(`[FolderBridge] recursiveCopy: dstRealPath=${dstRealPath}`);
						await fs.promises.copyFile(srcRealPath, dstRealPath);
					} else {
						// Same mount — use native copy
						logger.debug(`[FolderBridge] recursiveCopy: mount->mount using va.copy`);
						await va.copy(srcPath, dstPath);
					}
				} else {
					// Different storage types — read from source, write to destination
					logger.debug(`[FolderBridge] recursiveCopy: using read/write (different storage types)`);
					let content: Buffer;
					if (srcStorageType === 'vault') {
						logger.debug(`[FolderBridge] recursiveCopy: reading from vault`);
						const vaultAdapter = this.app.vault.adapter;
						content = Buffer.from(await vaultAdapter.read(srcPath));
					} else {
						logger.debug(`[FolderBridge] recursiveCopy: reading from mount: ${srcRealPath}`);
						content = await fs.promises.readFile(srcRealPath);
					}

					if (dstStorageType === 'vault') {
						logger.debug(`[FolderBridge] recursiveCopy: writing to vault: ${dstRealPath}`);
						// Use fs.promises.writeFile directly — va.writeBinary() would select by priority (mount wins)
						await fs.promises.mkdir(path.dirname(dstRealPath), { recursive: true });
						await fs.promises.writeFile(dstRealPath, content);
					} else {
						logger.debug(`[FolderBridge] recursiveCopy: writing to mount: ${dstRealPath}`);
						await fs.promises.mkdir(path.dirname(dstRealPath), { recursive: true });
						await fs.promises.writeFile(dstRealPath, content);
					}
				}
			}
		}

		/**
		 * Recursively move a file or folder from source to destination.
		 * Uses relative paths to avoid duplication in recursive calls.
		 * Handles conflicts when destination already exists.
		 */
		private async recursiveMove(
			srcPath: string,
			dstPath: string,
			rootSrcPath: string,
			rootDstPath: string,
			dstStorageType: 'vault' | MountPoint,
			conflictState: { skipAll: boolean; overwriteAll: boolean; totalConflicts: number; currentConflict: number },
		): Promise<void> {
			const va = this.virtualAdapter;
			if (!va) throw new Error('Folder Bridge: VirtualAdapter not initialized.');

			// Resolve storage types and real paths for source and destination
			const srcStorageType = await this.resolveStorageType(srcPath);
			const srcRealPath = await this.resolveRealPath(srcPath);
			const dstRealPath = await this.resolveRealPath(dstPath, dstStorageType);

			logger.debug(`[FolderBridge] recursiveMove: srcPath=${srcPath}, dstPath=${dstPath}`);
			logger.debug(`[FolderBridge] recursiveMove: srcStorageType=${typeof srcStorageType === 'string' ? srcStorageType : srcStorageType.virtualPath}, dstStorageType=${typeof dstStorageType === 'string' ? dstStorageType : dstStorageType.virtualPath}`);

			// Check if destination exists and user wants to skip/overwrite
			if (!conflictState.skipAll) {
				let dstExists = false;
				try {
					logger.debug(`[FolderBridge] recursiveMove: checking if dst exists: ${dstRealPath}`);
					await fs.promises.access(dstRealPath, fs.constants.F_OK);
					dstExists = true;
					logger.debug(`[FolderBridge] recursiveMove: dst EXISTS`);
				} catch {
					dstExists = false;
					logger.debug(`[FolderBridge] recursiveMove: dst does NOT exist`);
				}

				if (dstExists) {
					conflictState.currentConflict++;
					logger.debug(`[FolderBridge] recursiveMove: CONFLICT #${conflictState.currentConflict}/${conflictState.totalConflicts}, showing dialog`);
					if (!conflictState.overwriteAll) {
						const resolution = await ConflictResolutionModal.show(
							this.app,
							dstPath.split('/').pop()!,
							'move',
							conflictState.totalConflicts,
							conflictState.currentConflict - 1,
						);

						if (resolution === 'skip' || resolution === 'skipAll') {
							if (resolution === 'skipAll') conflictState.skipAll = true;
							logger.debug(`[FolderBridge] recursiveMove: user chose ${resolution}, skipping`);
							return;
						}
						if (resolution === 'overwriteAll') conflictState.overwriteAll = true;
						logger.debug(`[FolderBridge] recursiveMove: user chose ${resolution}, continuing`);
					}
				}
			}

			// Use stat to distinguish files from folders
			const stat = await va.stat(srcPath);
			logger.debug(`[FolderBridge] recursiveMove: src is ${stat?.type}`);
			if (stat && stat.type === 'folder') {
				// For folders, try atomic rename first (same storage type)
				logger.debug(`[FolderBridge] recursiveMove: same storage type: ${srcStorageType === dstStorageType}`);
				if (srcStorageType === dstStorageType && srcStorageType !== 'vault') {
					// Same mount — use atomic rename
					logger.debug(`[FolderBridge] recursiveMove: using atomic rename for folder`);
					await va.rename(srcPath, dstPath);
					return;
				}

				// Different storage types or vault involved — copy then delete
				logger.debug(`[FolderBridge] recursiveMove: using copy+delete for folder`);
				await this.recursiveCopy(srcPath, dstPath, rootSrcPath, rootDstPath, dstStorageType, conflictState);
				await this.recursiveDelete(srcPath, srcStorageType);
			} else {
				// Move file
				logger.debug(`[FolderBridge] recursiveMove: moving file, same storage type: ${srcStorageType === dstStorageType}`);
				if (srcStorageType === dstStorageType) {
					// Same storage type — use appropriate rename method
					logger.debug(`[FolderBridge] recursiveMove: using same-type rename`);
					if (srcStorageType === 'vault') {
						// Both in vault — use fs.rename with real paths
						logger.debug(`[FolderBridge] recursiveMove: vault->vault using fs.rename`);
						await fs.promises.rename(srcRealPath, dstRealPath);
					} else {
						// Same mount — use atomic rename
						logger.debug(`[FolderBridge] recursiveMove: mount->mount using va.rename`);
						await va.rename(srcPath, dstPath);
					}
				} else {
					// Different storage types — copy then delete
					logger.debug(`[FolderBridge] recursiveMove: using copy+delete for file`);
					await this.recursiveCopy(srcPath, dstPath, rootSrcPath, rootDstPath, dstStorageType, conflictState);
					await this.recursiveDelete(srcPath, srcStorageType);
				}
			}
		}

		/**
		 * Recursively delete a file or folder.
		 * Uses the resolved storage type to delete from the correct location.
		 */
	private async recursiveDelete(deletePath: string, srcStorageType: 'vault' | MountPoint): Promise<void> {
		const va = this.virtualAdapter;
		if (!va) return;

		logger.debug(`[FolderBridge] recursiveDelete: path=${deletePath}, storageType=${typeof srcStorageType === 'string' ? srcStorageType : srcStorageType.virtualPath}`);

		// Use stat to distinguish files from folders
		const stat = await va.stat(deletePath);
		logger.debug(`[FolderBridge] recursiveDelete: ${deletePath} is ${stat?.type}`);

		if (stat && stat.type === 'folder') {
			const listing = await va.list(deletePath);
			const allEntries = [...listing.files, ...listing.folders];
			logger.debug(`[FolderBridge] recursiveDelete: folder has ${allEntries.length} entries`);

			for (const entry of allEntries) {
				const entryPath = normalizePath(deletePath + '/' + entry);
				const entryStorageType = await this.resolveStorageType(entryPath);
				await this.recursiveDelete(entryPath, entryStorageType);
			}

			// Delete empty folder
			let realPath: string;
			if (srcStorageType === 'vault') {
				const vaultAdapter = this.app.vault.adapter;
				const vaultAdapterTyped = vaultAdapter as { basePath?: string; adapter?: { getBasePath?: () => string } };
				const basePath = vaultAdapterTyped.basePath
					?? vaultAdapterTyped.adapter?.getBasePath?.()
					?? '';
				realPath = path.join(basePath, deletePath.replace(/\//g, path.sep));
			} else {
				realPath = this.pathMapper.toRealPath(deletePath, srcStorageType);
			}
			logger.debug(`[FolderBridge] recursiveDelete: deleting folder: ${realPath}`);
			try {
				await fs.promises.rmdir(realPath);
			} catch {
				// Folder may already be empty or deleted
			}
		}

		// Delete the file
		let realPath: string;
		if (srcStorageType === 'vault') {
			const vaultAdapter = this.app.vault.adapter;
			const vaultAdapterTyped = vaultAdapter as { basePath?: string; adapter?: { getBasePath?: () => string } };
			const basePath = vaultAdapterTyped.basePath
				?? vaultAdapterTyped.adapter?.getBasePath?.()
				?? '';
			realPath = path.join(basePath, deletePath.replace(/\//g, path.sep));
		} else {
			realPath = this.pathMapper.toRealPath(deletePath, srcStorageType);
		}
		logger.debug(`[FolderBridge] recursiveDelete: deleting file: ${realPath}`);
		try {
			await fs.promises.unlink(realPath);
		} catch {
			// File may already be deleted
		}
	}

		async removeMount(id: string): Promise<void> {
		const idx = this.persistedMountPoints.findIndex(m => m.id === id);
		if (idx === -1) {
			const managedIndex = this.getManagedTocIndex(id);
			if (managedIndex === -1) return;

			const mount = this.managedTocMountPoints[managedIndex];
			await this.notifyVaultMountRemoved(mount);

			const nextManagedMounts = this.getManagedTocDraftMounts().filter(existing => existing.id !== id);
			if (!await this.writeManagedTocMounts(nextManagedMounts)) {
				if (mount.enabled) {
					await this.notifyVaultMountAdded(mount);
				}
				return;
			}

			await this.refreshTocMountSources(true);
			await this.saveSettings();
			this.updateStatusBar();
			new Notice(i18n.t('status.mounts.removed', { path: mount.virtualPath }));
			return;
		}

		const mount = this.persistedMountPoints[idx];

		// [BUGFIX_20260222] Remove from vault tree BEFORE removing from pathMapper so stat() still resolves
		await this.notifyVaultMountRemoved(mount);

		this.persistedMountPoints.splice(idx, 1);

		// Only revoke the allowlist entry if no other active mount shares the real path
		const stillUsed = this.persistedMountPoints.some(m => m.realPath === mount.realPath);
		if (!stillUsed) {
			this.persistedAllowlist = this.persistedAllowlist.filter(p => p !== mount.realPath);
			this.security.revoke(mount.realPath);
			// Revoke streaming-server access for this real path
			if (mount.realPath) this.fileServer.removeAllowedPath(mount.realPath);
		}

		// Tear down adapters and clear stored credentials
		if (mount.mountType === 'webdav') {
			this.virtualAdapter?.clearWebDAVAdapter(mount.id);
			clearWebDAVPassword(mount.id);
			if (mount.encryptedWebdavPassword) {
				delete mount.encryptedWebdavPassword;
				await this.saveSettings();
			}
		} else if (mount.mountType === 's3') {
			this.virtualAdapter?.clearS3Adapter(mount.id);
			clearSessionCredential('s3', mount.id);
			if (mount.encryptedS3SecretKey) {
				delete mount.encryptedS3SecretKey;
				await this.saveSettings();
			}
		} else if (mount.mountType === 'sftp') {
			this.virtualAdapter?.clearSFTPAdapter(mount.id);
			clearSessionCredential('sftp-pw', mount.id);
			clearSessionCredential('sftp-pp', mount.id);
			if (mount.encryptedSftpPassword) {
				delete mount.encryptedSftpPassword;
			}
			if (mount.encryptedSftpPassphrase) {
				delete mount.encryptedSftpPassphrase;
			}
			await this.saveSettings();
		}

		await this.saveSettings();
		this.syncEffectiveMountState();
		this.updateStatusBar();

		new Notice(`Folder Bridge: Removed mount "${mount.virtualPath}".`);
	}

	/**
	 * Update an existing mount in-place.  Handles vault-tree re-injection when
	 * the virtual path or real path changes, and keeps the allowlist in sync.
	 */
	/**
	 * Flip the read-only flag for a single mount, clear its one-shot notice
	 * record, persist settings, and show a confirmation Notice.
	 * @param skipNotice  Pass true when batch-toggling all mounts (caller shows a single summary Notice).
	 */
	async setMountReadOnly(id: string, readOnly: boolean, skipNotice = false): Promise<void> {
		const mount = this.persistedMountPoints.find(m => m.id === id);
		if (mount) {
			mount.readOnly = readOnly;
			this.virtualAdapter?.clearReadOnlyNotice(id);
			await this.saveSettings();
			this.syncEffectiveMountState();
			if (!skipNotice) {
				new Notice(i18n.t('status.mount.readOnlyState', {
					mount: mount.label || mount.virtualPath,
					state: readOnly ? i18n.t('state.readOnly').toLowerCase() : i18n.t('state.writable').toLowerCase(),
				}));
			}
			return;
		}

		const managedIndex = this.getManagedTocIndex(id);
		if (managedIndex === -1) return;

		const nextManagedMounts = this.getManagedTocDraftMounts();
		nextManagedMounts[managedIndex] = {
			...nextManagedMounts[managedIndex],
			readOnly,
		};
		if (!await this.writeManagedTocMounts(nextManagedMounts)) return;

		this.virtualAdapter?.clearReadOnlyNotice(id);
		await this.refreshTocMountSources(true);
		await this.saveSettings();
		const updatedMount = this.settings.mountPoints.find(existing => existing.id === id);
		if (!skipNotice && updatedMount) {
			new Notice(i18n.t('status.mount.readOnlyState', {
				mount: updatedMount.label || updatedMount.virtualPath,
				state: readOnly ? i18n.t('state.readOnly').toLowerCase() : i18n.t('state.writable').toLowerCase(),
			}));
		}
	}

	async setDeviceOverride(id: string, realPath: string): Promise<void> {
		const mount = this.settings.mountPoints.find(entry => entry.id === id);
		if (!mount || !this.isUserEditableMount(mount) || !realPath.trim()) return;
		const overridePath = realPath.trim();
		await this.updateMount(id, {
			...mount,
			deviceOverrides: { ...mount.deviceOverrides, [this.settings.deviceId]: overridePath },
		});
	}

	async updateMount(id: string, newData: Omit<MountPoint, 'id'>): Promise<void> {
		const previous = this.mountUpdates.get(id) ?? Promise.resolve();
		const update = previous.catch(() => { }).then(() => this.updateMountState(id, newData));
		this.mountUpdates.set(id, update);
		try {
			await update;
		} finally {
			if (this.mountUpdates.get(id) === update) this.mountUpdates.delete(id);
		}
	}

	private async updateMountState(id: string, newData: Omit<MountPoint, 'id'>): Promise<void> {
		const idx = this.persistedMountPoints.findIndex(m => m.id === id);
		if (idx === -1) {
			const managedIndex = this.getManagedTocIndex(id);
			if (managedIndex === -1) return;

			const oldMount = this.managedTocMountPoints[managedIndex];
			const otherMounts = this.settings.mountPoints.filter(m => m.id !== id);
			const error = this.security.validateMount(newData, otherMounts);
			if (error) {
				new Notice(i18n.t('notice.generic', { message: error }));
				return;
			}

			const wasEnabled = oldMount.enabled;
			const virtualPathChanged = normalizePath(oldMount.virtualPath) !== normalizePath(newData.virtualPath);
			const realPathChanged = oldMount.realPath !== newData.realPath;
			const fallbackChanged = (oldMount.fallbackRealPath ?? '') !== (newData.fallbackRealPath ?? '');
			const visibleFileFilterChanged = oldMount.visibleFileFilter !== newData.visibleFileFilter;
			const overrideChanged = oldMount.deviceOverrides?.[this.settings.deviceId] !==
				('deviceOverrides' in newData ? newData.deviceOverrides : oldMount.deviceOverrides)?.[this.settings.deviceId];
			const requiresReinjection = virtualPathChanged || realPathChanged || visibleFileFilterChanged || fallbackChanged || overrideChanged;

			if (wasEnabled && requiresReinjection) {
				await this.notifyVaultMountRemoved(oldMount);
			}

			const nextManagedMounts = this.getManagedTocDraftMounts();
			nextManagedMounts[managedIndex] = {
				...nextManagedMounts[managedIndex],
				...newData,
				id,
			};

			if (!await this.writeManagedTocMounts(nextManagedMounts)) {
				if (wasEnabled && requiresReinjection) {
					await this.notifyVaultMountAdded(oldMount);
				}
				return;
			}

			await this.refreshTocMountSources(true);
			await this.saveSettings();
			this.updateStatusBar();

			const updatedMount = this.settings.mountPoints.find(existing => existing.id === id);
			if (!updatedMount) return;

			if (wasEnabled && requiresReinjection) {
				await this.notifyVaultMountAdded(updatedMount);
			}

			const watcherSettingsChanged =
				oldMount.visibleFileFilter !== updatedMount.visibleFileFilter ||
				oldMount.watcherSuppressAllEvents !== updatedMount.watcherSuppressAllEvents ||
				oldMount.watcherCreateFilter !== updatedMount.watcherCreateFilter ||
				oldMount.watcherDebounceMs !== updatedMount.watcherDebounceMs ||
				oldMount.watcherUsePolling !== updatedMount.watcherUsePolling ||
				oldMount.watcherPollingIntervalMs !== updatedMount.watcherPollingIntervalMs;
			if (watcherSettingsChanged && wasEnabled && !requiresReinjection) {
				this.fileWatcher?.stopWatching(oldMount);
				this.fileWatcher?.startWatching(updatedMount);
			}

			new Notice(i18n.t('status.mounts.updated', { path: updatedMount.virtualPath }));
			return;
		}

		const oldMount = this.persistedMountPoints[idx];

		// Validate against all OTHER mounts (exclude the one being edited)
		const otherMounts = this.settings.mountPoints.filter(m => m.id !== id);
		const error = this.security.validateMount(newData, otherMounts);
		if (error) {
			new Notice(i18n.t('notice.generic', { message: error }));
			return;
		}

		const wasEnabled = oldMount.enabled;
		const virtualPathChanged = normalizePath(oldMount.virtualPath) !== normalizePath(newData.virtualPath);
		const realPathChanged = oldMount.realPath !== newData.realPath;
		const fallbackChanged = (oldMount.fallbackRealPath ?? '') !== (newData.fallbackRealPath ?? '');
		const visibleFileFilterChanged = oldMount.visibleFileFilter !== newData.visibleFileFilter;
		const overrideChanged = oldMount.deviceOverrides?.[this.settings.deviceId] !==
			('deviceOverrides' in newData ? newData.deviceOverrides : oldMount.deviceOverrides)?.[this.settings.deviceId];
		const requiresReinjection = virtualPathChanged || realPathChanged || visibleFileFilterChanged || fallbackChanged || overrideChanged;

		// Remove from vault tree before mutating PathMapper state
		if (wasEnabled && requiresReinjection) {
			await this.notifyVaultMountRemoved(oldMount);
		}

		// Keep allowlist in sync when real path changes (local mounts only)
		const newMountType = (newData as MountPoint).mountType;
		const newIsCloud = newMountType === 'webdav' || newMountType === 's3' || newMountType === 'sftp';
		const oldIsCloud = oldMount.mountType === 'webdav' || oldMount.mountType === 's3' || oldMount.mountType === 'sftp';
		if (realPathChanged) {
			if (!oldIsCloud) {
				const stillUsed = otherMounts.some(m => m.realPath === oldMount.realPath);
				if (!stillUsed) {
					this.persistedAllowlist = this.persistedAllowlist.filter(p => p !== oldMount.realPath);
					this.security.revoke(oldMount.realPath);
				}
			}
			if (!newIsCloud && !this.persistedAllowlist.includes(newData.realPath)) {
				this.persistedAllowlist.push(newData.realPath);
				this.security.allow(newData.realPath);
			}
		}

		if (fallbackChanged && !newIsCloud) {
			if (oldMount.fallbackRealPath) {
				const stillUsed = otherMounts.some(m => m.realPath === oldMount.fallbackRealPath || m.fallbackRealPath === oldMount.fallbackRealPath);
				if (!stillUsed) {
					this.persistedAllowlist = this.persistedAllowlist.filter(allowlistPath => allowlistPath !== oldMount.fallbackRealPath);
					this.security.revoke(oldMount.fallbackRealPath);
				}
			}
			if (newData.fallbackRealPath && !this.persistedAllowlist.includes(newData.fallbackRealPath)) {
				this.persistedAllowlist.push(newData.fallbackRealPath);
				this.security.allow(newData.fallbackRealPath);
			}
		}

		// Preserve id, deviceId, ignoreList, and deviceOverrides from the original
		this.persistedMountPoints[idx] = {
			...oldMount,
			...newData,
			id,
		};

		await this.saveSettings();
		this.syncEffectiveMountState();
		this.updateStatusBar();

		const updatedMount = this.persistedMountPoints[idx];

		// Recreate adapters when mount type or credentials change
		if (updatedMount.mountType === 'webdav') {
			const { webdavPassword } = newData as MountPoint;
			if (webdavPassword) {
				saveWebDAVPassword(id, webdavPassword);
				const encrypted = encryptCredential(webdavPassword);
				if (encrypted) {
					this.persistedMountPoints[idx].encryptedWebdavPassword = encrypted;
					await this.saveSettings();
				}
			}
			this.virtualAdapter?.clearWebDAVAdapter(id);
			const adapter = WebDAVAdapter.fromMount(updatedMount);
			if (adapter) this.virtualAdapter?.setWebDAVAdapter(id, adapter);
		} else if (oldMount.mountType === 'webdav') {
			this.virtualAdapter?.clearWebDAVAdapter(id);
			clearWebDAVPassword(id);
		}

		if (updatedMount.mountType === 's3') {
			const { s3SecretKey } = newData as MountPoint;
			if (s3SecretKey) {
				saveSessionCredential('s3', id, s3SecretKey);
				const encrypted = encryptCredential(s3SecretKey);
				if (encrypted) {
					this.persistedMountPoints[idx].encryptedS3SecretKey = encrypted;
					await this.saveSettings();
				}
			}
			this.virtualAdapter?.clearS3Adapter(id);
			const s3 = S3Adapter.fromMount(updatedMount);
			if (s3) this.virtualAdapter?.setS3Adapter(id, s3);
		} else if (oldMount.mountType === 's3') {
			this.virtualAdapter?.clearS3Adapter(id);
			clearSessionCredential('s3', id);
		}

		if (updatedMount.mountType === 'sftp') {
			const { sftpPassword, sftpPassphrase } = newData as MountPoint;
			if (sftpPassword) {
				saveSessionCredential('sftp-pw', id, sftpPassword);
				const encrypted = encryptCredential(sftpPassword);
				if (encrypted) {
					this.persistedMountPoints[idx].encryptedSftpPassword = encrypted;
					await this.saveSettings();
				}
			}
			if (sftpPassphrase) {
				saveSessionCredential('sftp-pp', id, sftpPassphrase);
				const encrypted = encryptCredential(sftpPassphrase);
				if (encrypted) {
					this.persistedMountPoints[idx].encryptedSftpPassphrase = encrypted;
					await this.saveSettings();
				}
			}
			this.virtualAdapter?.clearSFTPAdapter(id);
			const sftpAdapter = SFTPAdapter.fromMount(updatedMount);
			if (sftpAdapter) this.virtualAdapter?.setSFTPAdapter(id, sftpAdapter);
		} else if (oldMount.mountType === 'sftp') {
			this.virtualAdapter?.clearSFTPAdapter(id);
			clearSessionCredential('sftp-pw', id);
			clearSessionCredential('sftp-pp', id);
		}

		// Re-inject when enabled and something structural changed
		if (wasEnabled && requiresReinjection) {
			await this.notifyVaultMountAdded(updatedMount);
		}

		// Restart watcher when real path or any watcher-related setting changes.
		// The chokidar callbacks capture `mount` by reference at startWatching() time.
		// If the mount object is replaced (as updateMount() does via spread merge) without
		// restarting the watcher, the closure reads stale values — e.g. watcherSuppressAllEvents
		// set to true in Settings would have no effect until the plugin is reloaded.
		const watcherSettingsChanged =
			oldMount.visibleFileFilter !== updatedMount.visibleFileFilter ||
			oldMount.watcherSuppressAllEvents !== updatedMount.watcherSuppressAllEvents ||
			oldMount.watcherCreateFilter !== updatedMount.watcherCreateFilter ||
			oldMount.watcherDebounceMs !== updatedMount.watcherDebounceMs ||
			oldMount.watcherUsePolling !== updatedMount.watcherUsePolling ||
			oldMount.watcherPollingIntervalMs !== updatedMount.watcherPollingIntervalMs;
		if (watcherSettingsChanged && wasEnabled && !requiresReinjection) {
			this.fileWatcher?.stopWatching(oldMount);
			this.fileWatcher?.startWatching(updatedMount);
		}

		new Notice(i18n.t('status.mounts.updated', { path: updatedMount.virtualPath }));
		// Refresh tag-based commands after updating a mount (tags may have changed)
		this.refreshTagCommands();
	}

	/**
	 * Removes previously registered tag commands and re-registers them.
	 * Used when the interface language changes so command names are re-localized.
	 */
	public rebuildTagCommands(): void {
		for (const id of this.registeredTagNames) {
			this.removeCommand(id);
		}
		this.registeredTagNames.clear();
		this.refreshTagCommands();
	}

	private refreshTagCommands(): void {
		// Collect all unique tags from current mounts
		const allTags = new Set<string>();
		for (const mount of this.settings.mountPoints) {
			if (mount.tags && mount.tags.length > 0) {
				for (const tag of mount.tags) {
					const trimmed = tag.trim();
					if (trimmed) allTags.add(trimmed);
				}
			}
		}

		// Register commands for current tags (only once per tag)
		for (const tag of allTags) {
			const tagName = tag;
			const mountCmdId = `mount-tag-${tagName}`;
			const unmountCmdId = `unmount-tag-${tagName}`;

			// Only register if not already registered
			if (!this.registeredTagNames.has(mountCmdId)) {
				// Mount command — hidden if no mounts with this tag exist
				this.addCommand({
					id: mountCmdId,
					name: i18n.t('command.tagMountOn.name', { tag: tagName }),
					checkCallback: (checking: boolean) => {
						const mountsWithTag = this.settings.mountPoints.filter(
							m => m.tags && m.tags.includes(tagName) && this.isUserEditableMount(m) && this.isMountEnabledOnThisDevice(m),
						);
						if (mountsWithTag.length === 0) return false;
						if (!checking) {
							void (async () => {
								for (const mount of mountsWithTag) {
									if (mount.enabled) continue;
									mount.enabled = true;
									await this.persistEditableMountFromState(mount);
									await this.notifyVaultMountAdded(mount);
								}
								this.updateStatusBar();
								new Notice(
									i18n.t('command.tagMount.on', { tag: tagName, count: mountsWithTag.length }),
								);
							})();
						}
						return true;
					},
				});

				// Unmount command — hidden if no mounts with this tag exist
				this.addCommand({
					id: unmountCmdId,
					name: i18n.t('command.tagMountOff.name', { tag: tagName }),
					checkCallback: (checking: boolean) => {
						const mountsWithTag = this.settings.mountPoints.filter(
							m => m.tags && m.tags.includes(tagName) && this.isUserEditableMount(m) && this.isMountEnabledOnThisDevice(m),
						);
						if (mountsWithTag.length === 0) return false;
						if (!checking) {
							void (async () => {
								for (const mount of mountsWithTag) {
									if (!mount.enabled) continue;
									await this.notifyVaultMountRemoved(mount);
									mount.enabled = false;
									await this.persistEditableMountFromState(mount);
								}
								this.updateStatusBar();
								new Notice(
									i18n.t('command.tagMount.off', { tag: tagName, count: mountsWithTag.length }),
								);
							})();
						}
						return true;
					},
				});

				this.registeredTagNames.add(mountCmdId);
				this.registeredTagNames.add(unmountCmdId);
			}
		}
	}

	// ------------------------------------------------------------------
	// Vault file-tree injection
	// ------------------------------------------------------------------

	/**
	 * Notify Obsidian's internal vault index that a new virtual mount folder
	 * exists so it appears in the file explorer without requiring a restart.
	 *
	 * Obsidian's internal `vault.onChange('created', path)` is the same hook
	 * the OS file-watcher uses to signal new paths.  Because our VirtualAdapter
	 * intercepts `adapter.stat()`, Obsidian correctly identifies each segment
	 * as a folder and inserts it into its internal TFolder tree.
	 */
	async notifyVaultMountAdded(mount: MountPoint): Promise<void> {
		const token = Symbol();
		this.mountInjections.set(mount.id, token);
		const isCurrent = () => this.mountInjections.get(mount.id) === token;
		this.fileWatcher?.stopWatching(mount);
		await this.resolveMountPath(mount, isCurrent);
		if (!isCurrent()) return;

		const vault = this.app.vault as typeof this.app.vault & VaultInternal;

		if (typeof vault.onChange !== 'function') {
			logger.debug("vault.onChange is not a function!");
			return;
		}

		// Walk every path segment so intermediate virtual folders also appear
		// (e.g. mounting "Projects/Work" also surfaces the "Projects" folder).
		const segments = normalizePath(mount.virtualPath).split('/');
		for (let i = 1; i <= segments.length; i++) {
			if (!isCurrent()) return;
			const partPath = segments.slice(0, i).join('/');
			// Skip segments Obsidian already knows about
			if (this.app.vault.getAbstractFileByPath(partPath)) continue;
			try {
				await vault.onChange('folder-created', partPath, null, null);
			} catch (e) {
				logger.debug('Folder Bridge: vault.onChange(folder-created) unavailable', e);
			}
		}

		// Recursively notify Obsidian about all files and folders inside the mount
		const suppressionEnabled = !!mount.watcherSuppressAllEvents;

		const notice = new Notice(i18n.t('status.scanning', { path: mount.virtualPath }), 0);
		let lastProgressRender = -Infinity;
		const { fileCount, folderCount, scanLimitHit } = await replayMountContentsToVault(mount, {
			list: (folderPath) => isCurrent() ? this.app.vault.adapter.list(folderPath) : Promise.resolve({ files: [], folders: [] }),
			stat: (filePath) => isCurrent() ? this.app.vault.adapter.stat(filePath) : Promise.resolve(null),
			hasAbstractFile: (path) => !!this.app.vault.getAbstractFileByPath(path),
			isIgnored: (name, activeMount, mountRelativePath) => this.isNameIgnored(name, activeMount, mountRelativePath),
			onFolderCreated: (path) => isCurrent() ? vault.onChange('folder-created', path, null, null) : Promise.resolve(),
			onFileCreated: (path, stat) => isCurrent() ? vault.onChange('file-created', path, null, stat) : Promise.resolve(),
			onProgress: ({ fileCount, folderCount }) => {
				if (!isCurrent()) return;
				const now = performance.now();
				if (now - lastProgressRender < 100) return;
				lastProgressRender = now;
				notice.setMessage(i18n.t('status.scanningProgress', {
					path: mount.virtualPath,
					folderCount,
					fileCount,
				}));
			},
			onHugeMount: () => {
				if (isCurrent()) notice.setMessage(i18n.t('status.hugeMount', { path: mount.virtualPath }));
			},
			onError: (folderPath, error) => {
				logger.debug(`Folder Bridge: Failed to list ${folderPath}`, error);
			},
		}).finally(() => notice.hide());
		if (!isCurrent()) return;
		if (scanLimitHit) {
			const scanLimit = mount.maxFiles ?? 0;
			new Notice(
				i18n.t('status.scanLimitReached', { limit: scanLimit.toLocaleString(), path: mount.virtualPath }),
				10000
			);
		}
		if (suppressionEnabled) {
			new Notice(i18n.t('status.mounted.withEventsSuppressed', { path: mount.virtualPath }));
		} else {
			new Notice(i18n.t('status.mounted.count', { path: mount.virtualPath, count: folderCount, fileCount }));
			try {
				await vault.onChange('raw', normalizePath(mount.virtualPath), null, null);
			} catch (e) {
				logger.debug('Folder Bridge: vault.onChange(raw) unavailable', e);
			}
		}

		// Restore Folder Bridge's own expansion cache after virtual folders have
		// been injected. Obsidian restores native folder state before these paths
		// exist, so mount folders need this late pass.
		if (!suppressionEnabled) setTimeout(() => {
			if (!isCurrent()) return;
			this.applySavedExplorerExpansionState(mount);
		}, 100);

		// [FEATURE_20260222] Start watching the mount for external changes
		if (isCurrent()) this.fileWatcher?.startWatching(mount);

		// Refresh file-explorer highlights after mount injection
		this.scheduleExplorerWork(() => {
			if (isCurrent()) this.highlightMountedInExplorer();
		}, 200);
	}

	/**
	 * Remove a virtual mount folder from Obsidian's internal vault index
	 * so the file explorer stops showing it immediately after removal.
	 *
	 * [BUGFIX_20260222] This method must be called BEFORE the mount is removed
	 * from the PathMapper, otherwise adapter.list() will fail to resolve the
	 * virtual paths to real paths, and the files will remain orphaned in the UI.
	 */
	async notifyVaultMountRemoved(mount: MountPoint): Promise<void> {
		const token = Symbol();
		this.mountInjections.set(mount.id, token);
		const isCurrent = () => this.mountInjections.get(mount.id) === token;
		this.fileWatcher?.stopWatching(mount);

		const vault = this.app.vault as typeof this.app.vault & VaultInternal;
		if (typeof vault.onChange !== 'function') return;

		const nPath = normalizePath(mount.virtualPath);
		logger.warn(`[FolderBridge] notifyVaultMountRemoved: virtualPath="${mount.virtualPath}", nPath="${nPath}"`);

		const mountFolder = this.app.vault.getAbstractFileByPath(nPath);
			if (!mountFolder || !(mountFolder instanceof TFolder)) return;

			const notice = new Notice(i18n.t('status.removing', { path: mount.virtualPath }), 0);
			let removedCount = 0;

			// [SMART FIX] Получаем доступ к оригинальному адаптеру основного хранилища
			const origAdapter = (this.app.vault.adapter as any).orig?.() || (this as any).originalAdapter;
			
			const collectAndRemove = async (folder: TFolder): Promise<void> => {
				for (const child of [...folder.children]) {
					if (!isCurrent()) return;
					
					// Проверяем, существует ли этот файл/папка в ОСНОВНОМ хранилище
					let existsInPrimary = false;
					try {
						existsInPrimary = await origAdapter.exists(child.path);
					} catch (e) {
						logger.debug(`Folder Bridge: Error checking primary existence for ${child.path}`, e);
					}
					
					if (!existsInPrimary) {
						// Файла нет в основном хранилище, значит он добавлен маунтом. Безопасно удаляем из индекса.
						try {
							if (child instanceof TFolder) {
								await collectAndRemove(child); // Сначала рекурсивно чистим содержимое
								await vault.onChange('folder-removed', child.path, null, null);
							} else {
								await vault.onChange('file-removed', child.path, null, null);
							}
							removedCount++;
						} catch (e) {
							logger.debug('Folder Bridge: Failed to remove item from vault view', e);
						}
					} else if (child instanceof TFolder) {
						// Файл/папка есть в основном хранилище, не удаляем её.
						// Но рекурсивно проверяем её содержимое, вдруг там есть файлы только из маунта.
						await collectAndRemove(child);
					}
				}
			};

			try {
				await collectAndRemove(mountFolder);
				
				if (!isCurrent() || this.app.vault.getAbstractFileByPath(nPath) !== mountFolder) return;
				
				if (isCurrent()) new Notice(i18n.t('status.unmounted.cleaned', { path: mount.virtualPath, count: removedCount }));
			} finally {
				notice.hide();
			}

			// Refresh file-explorer highlights after mount removal
			this.scheduleExplorerWork(() => {
				if (isCurrent()) this.highlightMountedInExplorer();
			}, 200);
		}
	// ------------------------------------------------------------------

	/**
	 * Rebuild the ignore cache and immediately remove from Obsidian's vault
	 * index any files/folders under `mount` that are now matched by the
	 * current ignore list.  Call this after adding a new pattern so the file
	 * explorer hides matching items without requiring a restart.
	 */
	async applyIgnoreListToVault(mount: MountPoint): Promise<void> {
		this.updateIgnoreCache();

		const vault = this.app.vault as typeof this.app.vault & VaultInternal;
		if (typeof vault.onChange !== 'function') return;

		const mountPath = normalizePath(mount.virtualPath);
		const mountFolder = this.app.vault.getAbstractFileByPath(mountPath);
		if (!(mountFolder instanceof TFolder)) return;

		const recursivelyRemoveIgnored = async (folder: TFolder): Promise<void> => {
			for (const child of [...folder.children]) {
				const mountRelative = child.path.startsWith(mountPath + '/')
					? child.path.slice(mountPath.length + 1)
					: child.path;
				if (this.isNameIgnored(child.name, mount, mountRelative)) {
					try {
						if (child instanceof TFolder) {
							await vault.onChange('folder-removed', child.path, null, null);
						} else {
							await vault.onChange('file-removed', child.path, null, null);
						}
					} catch (e) {
						logger.debug('Folder Bridge: Failed to remove ignored item from vault view', e);
					}
				} else if (child instanceof TFolder) {
					await recursivelyRemoveIgnored(child);
				}
			}
		};

		await recursivelyRemoveIgnored(mountFolder);
	}

	// ------------------------------------------------------------------
	// Mount health checking
	// ------------------------------------------------------------------

	/**
	 * Start the background 30-second reachability loop.
	 * Runs one immediate check on call, then fires every CHECK_INTERVAL_MS.
	 * When reachability changes, fires a Notice and refreshes the status bar.
	 */
	private startHealthChecks(): void {
		const CHECK_INTERVAL_MS = 30_000;

		const runCheck = async () => {
			// Avoid churning I/O while Obsidian is in the background
			if (typeof document !== 'undefined' && document.hidden) return;

			const activeMounts = this.settings.mountPoints.filter(m => m.enabled && this.isMountEnabledOnThisDevice(m));

			let anyChanged = false;
			for (const mount of activeMounts) {
				let reachable = false;
				try {
					if (mount.mountType === 'webdav') {
						const adapter = WebDAVAdapter.fromMount(mount);
						if (adapter) reachable = await adapter.exists(mount.realPath);
					} else if (mount.mountType === 's3') {
						const s3 = S3Adapter.fromMount(mount);
						if (s3) reachable = (await s3.testConnection()) === null;
					} else if (mount.mountType === 'sftp') {
						const sftpAdapter = SFTPAdapter.fromMount(mount);
						if (sftpAdapter) reachable = (await sftpAdapter.testConnection()) === null;
					} else {
						// Local mounts require Node.js fs — unavailable on mobile
						if (fs && fs.promises) {
							const realPath = this.pathMapper.getEffectiveRealPath(mount);
							await fs.promises.access(realPath, fs.constants.F_OK);
							reachable = true;
						}
					}
				} catch {
					reachable = false;
				}
				const prev = this.mountHealthMap.get(mount.id);
				if (prev !== reachable) {
					this.mountHealthMap.set(mount.id, reachable);
					anyChanged = true;
					if (!reachable && prev === true) {
						new Notice(
							`Folder Bridge: "${mount.label || mount.virtualPath}" is unreachable. ` +
							`Check that the path exists and is accessible on this device.`,
							8000
						);
					} else if (reachable && prev === false) {
						new Notice(
							`Folder Bridge: "${mount.label || mount.virtualPath}" is back online.`,
							4000
						);
					}
				}
			}
			if (anyChanged) this.updateStatusBar();
		};

		void runCheck(); // immediate first pass
		this.healthCheckInterval = setInterval(() => void runCheck(), CHECK_INTERVAL_MS);
	}

	/**
	 * Re-check whether mount's real path is accessible now.
	 * If it is, remove stale vault-tree entries and re-inject the mount.
	 * Called from the settings tab "Reconnect" button.
	 */
	async reconnectMount(mount: MountPoint): Promise<void> {
		let reachable = false;
		try {
			if (mount.mountType === 'webdav') {
				const adapter = WebDAVAdapter.fromMount(mount);
				if (adapter) reachable = await adapter.exists(mount.realPath);
			} else if (mount.mountType === 's3') {
				const s3 = S3Adapter.fromMount(mount);
				if (s3) reachable = (await s3.testConnection()) === null;
			} else if (mount.mountType === 'sftp') {
				const sftpAdapter = SFTPAdapter.fromMount(mount);
				if (sftpAdapter) reachable = (await sftpAdapter.testConnection()) === null;
			} else {
				if (fs && fs.promises) {
					await this.resolveMountPath(mount);
					const realPath = this.pathMapper.getEffectiveRealPath(mount);
					await fs.promises.access(realPath, fs.constants.F_OK);
					reachable = true;
				}
			}
		} catch {
			reachable = false;
		}
		this.mountHealthMap.set(mount.id, reachable);

		if (!reachable) {
			new Notice(i18n.t('status.mount.stillUnreachable', { mount: mount.label || mount.virtualPath }), 5000);
			this.updateStatusBar();
			return;
		}

		// Clean up any stale vault-tree remnants before re-injecting
		await this.notifyVaultMountRemoved(mount);
		await this.notifyVaultMountAdded(mount);
		new Notice(i18n.t('status.mount.reconnected', { mount: mount.label || mount.virtualPath }));
		this.updateStatusBar();
	}

	// ------------------------------------------------------------------
	// Status bar
	// ------------------------------------------------------------------

	/**
	 * Temporarily suppress (or restore) vault-event dispatching for one mount
	 * or for all mounts at once.  Suppression state is runtime-only: it resets
	 * the next time the plugin is reloaded.
	 *
	 * **Why this is useful:** External sync tools (Obsidian Sync, rclone, rsync,
	 * Syncthing…) write files directly to the bridged folder on disk.  Chokidar
	 * detects those writes and FolderBridge forwards them as vault events, which
	 * causes attachment-rename or note-refactor plugins to react as if the files
	 * were freshly created by the user.  By muting events around a sync window
	 * you prevent those spurious reactions while still letting user-initiated
	 * actions (e.g. paste image from clipboard) go through Obsidian's own
	 * internal vault path, which is unaffected by this flag.
	 *
	 * **Usage from external scripts** (Templater, JS Engine, QuickAdd, etc.):
	 * ```js
	 * const fb = app.plugins.getPlugin('folderbridge');
	 * fb.setWatcherSuppressed(null, true);           // mute all mounts
	 * // … wait for sync to finish …
	 * fb.setWatcherSuppressed(null, false);          // restore all mounts
	 *
	 * // Or target a single mount by its id (visible in Folder Bridge settings):
	 * fb.setWatcherSuppressed('abc123def', true);
	 * ```
	 *
	 * @param mountId  The mount's `id` string, or `null` to affect every mount.
	 * @param suppress `true` to mute events, `false` to restore them.
	 */
	setWatcherSuppressed(mountId: string | null, suppress: boolean): void {
		this.fileWatcher?.setSuppressed(mountId, suppress);
		this.updateStatusBar();
	}

	updateStatusBar(): void {
		if (!this.statusBarItem) return;
		const active = this.settings.mountPoints.filter(m => m.enabled).length;
		const unreachableCount = [...this.mountHealthMap.values()].filter(v => v === false).length;
		const allSuppressed = this.fileWatcher?.isSuppressedAll() ?? false;
		if (allSuppressed) {
			this.statusBarItem.setText(i18n.t('statusBar.eventsPaused', { plugin: this.manifest.name }));
			this.statusBarItem.classList.remove('folderbridge-status-warning');
			this.statusBarItem.classList.add('folderbridge-status-suppressed');
		} else if (unreachableCount > 0) {
			this.statusBarItem.setText(i18n.t('statusBar.unreachable', { count: unreachableCount }));
			this.statusBarItem.classList.remove('folderbridge-status-suppressed');
			this.statusBarItem.classList.add('folderbridge-status-warning');
		} else {
			this.statusBarItem.setText(i18n.t('statusBar.mounts', { count: active }));
			this.statusBarItem.classList.remove('folderbridge-status-suppressed', 'folderbridge-status-warning');
		}
	}

	// ------------------------------------------------------------------
	// Settings persistence
	// ------------------------------------------------------------------

	async loadSettings() {
		const data = await this.loadData() as Record<string, unknown>;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		this.settings.managedTocSource = this.settings.managedTocSource ?? '';
		this.settings.managedTocSourceFallback = this.settings.managedTocSourceFallback ?? '';
		this.settings.explorerExpansionState = {
			...(this.settings.explorerExpansionState ?? {}),
		};
		this.persistedMountPoints = [...this.settings.mountPoints];
		this.persistedAllowlist = [...this.settings.allowlist];

		// Generate a unique device ID if one doesn't exist
		if (!this.settings.deviceId) {
			this.settings.deviceId = generateId();
		}

		// Back-compat: assign ids to mounts created before the id field existed
		for (const m of this.persistedMountPoints) {
			if (!m.id) m.id = generateId();
			// Back-compat: assign deviceId to mounts created before deviceId existed
			if (!m.deviceId) m.deviceId = this.settings.deviceId;
			// Back-compat: assign default priority to mounts created before priority field existed
			if (m.priority === undefined || m.priority === null || typeof m.priority !== 'number') {
				m.priority = 0;
			}
		}

		// Back-compat: enableMountMerging defaults to false for existing users
		this.settings.enableMountMerging = this.settings.enableMountMerging ?? false;

		// Back-compat: enableExplorerHighlight defaults to false for existing users
		this.settings.enableExplorerHighlight = this.settings.enableExplorerHighlight ?? false;

		// Back-compat: assign default highlightColor to mounts created before the field existed
		for (const m of this.persistedMountPoints) {
			if (m.highlightColor === undefined || m.highlightColor === null) {
				m.highlightColor = '';
			}
		}

		// Back-compat: migrate global ignoreList to per-mount ignoreList
		const legacySettings = this.settings as FolderBridgeSettings & Record<string, unknown>;
		if (legacySettings['ignoreList'] && Array.isArray(legacySettings['ignoreList'])) {
			const legacyIgnoreList = legacySettings['ignoreList'] as string[];
			for (const m of this.persistedMountPoints) {
				if (!m.ignoreList) {
					m.ignoreList = [...legacyIgnoreList];
				}
			}
			delete legacySettings['ignoreList'];
		}

		await this.resolveAndCacheManagedTocSource();
		this.syncEffectiveMountState();
		await this.saveSettings();
		this.updateIgnoreCache();
	}

	async saveSettings() {
		// Strip transient webdavPassword field before persisting — it must never
		// reach data.json.  We deep-clone only the mount points array to avoid
		// mutating the live in-memory objects.
		const dataToSave = {
			...this.settings,
			allowlist: [...this.persistedAllowlist],
			mountPoints: this.persistedMountPoints.map(m => {
				const rest = { ...m };
				delete rest.webdavPassword;
				delete rest.s3SecretKey;
				delete rest.sftpPassword;
				delete rest.sftpPassphrase;
				delete rest.tocSourcePath;
				return rest;
			}),
		};
		await this.saveData(dataToSave);
		this.updateIgnoreCache();
	}
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

class FolderBridgeSettingTab extends PluginSettingTab {
	plugin: FolderBridgePlugin;
	private selectedIgnoreMountId: string | null = null;
	/** ID of the mount row being dragged (for reorder drag-drop). */
	private dragSrcId: string | null = null;

	constructor(app: App, plugin: FolderBridgePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		// Render sync part, then trigger async refresh for mount statuses
		this.renderSync();
	}

	private renderSync(): void {
		const { containerEl } = this;
		containerEl.empty();
		const pluginName = this.plugin.manifest.name;
		const ctrlCmd = 'Ctrl / Cmd';
		const ghRepo = 'repo';
		const moreProj = 'projects';
		const buyMe = 'me a coffee';

		// ── Header ──────────────────────────────────────────────────────

		const infoDiv = containerEl.createDiv('folderbridge-info-box');

		infoDiv.createEl('p', {
			text: i18n.t('syncWarning.header', {
				platform: getPlatform(),
				deviceId: this.plugin.settings.deviceId.substring(0, 8),
			}),
			cls: 'setting-item-description folderbridge-info-meta',
		});

		const syncWarning = infoDiv.createEl('p', {
			cls: 'setting-item-description folderbridge-sync-warning',
		});
		syncWarning.createEl('strong', { text: i18n.t('syncWarning.pluginNameHeader') });
		syncWarning.appendText(' ');
		syncWarning.appendText(i18n.t('syncWarning.body'));

		// ── Language selector ───────────────────────────────────────────────
		const currentLanguage = this.plugin.settings.language;

		new Setting(containerEl)
			.setName(i18n.t('settings.language.name'))
			.setDesc(i18n.t('settings.language.desc'))
			.addDropdown(dropdown => {
				dropdown.addOption('auto', i18n.t('settings.language.auto'));
				dropdown.addOption('en', i18n.t('settings.language.en'));
				dropdown.addOption('ru', i18n.t('settings.language.ru'));
				dropdown.setValue(currentLanguage ?? 'auto');
				dropdown.onChange(val => {
					void (async () => {
						this.plugin.settings.language = val as Language;
						await this.plugin.saveSettings();
						// Reinitialize i18n with new language
						i18n.init(this.plugin.settings.language, this.plugin.manifest.name);
						// Re-register tag commands so their names are re-localized
						this.plugin.rebuildTagCommands();
						// Refresh the settings tab to apply changes
						this.renderSync();
					})();
				});
			});

		// ── Global options ───────────────────────────────────────────────

		new Setting(containerEl)
			.setName(i18n.t('settings.dryRun.name'))
			.setDesc(i18n.t('settings.dryRun.desc'))
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.dryRun)
				.onChange(val => {
					void (async () => {
						this.plugin.settings.dryRun = val;
						await this.plugin.saveSettings();
						this.plugin.virtualAdapter?.setDryRun(val);
					})();
				}));

		new Setting(containerEl)
			.setName(i18n.t('settings.enableMountMerging.name'))
			.setDesc(i18n.t('settings.enableMountMerging.desc'))
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableMountMerging)
				.onChange(val => {
					void (async () => {
						this.plugin.settings.enableMountMerging = val;
						await this.plugin.saveSettings();
						this.plugin.virtualAdapter?.setEnableMountMerging(val);
					})();
				}));

		new Setting(containerEl)
			.setName(i18n.t('settings.debugLogging.name'))
			.setDesc(i18n.t('settings.debugLogging.desc'))
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.debugLogging)
				.onChange(val => {
					void (async () => {
						this.plugin.settings.debugLogging = val;
						await this.plugin.saveSettings();
						this.plugin.virtualAdapter?.setDebugLogging(val);
					})();
				}));

		new Setting(containerEl)
			.setName(i18n.t('settings.showStatusBar.name'))
			.setDesc(i18n.t('settings.showStatusBar.desc'))
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showStatusBar)
				.onChange(val => {
					void (async () => {
						this.plugin.settings.showStatusBar = val;
						await this.plugin.saveSettings();

						// Dynamically show/hide the status bar item without requiring a reload
						if (val) {
							// Show status bar item if it doesn't exist yet
							if (!this.plugin.statusBarItem) {
								this.plugin.statusBarItem = this.plugin.addStatusBarItem();
								this.plugin.updateStatusBar();
							}
						} else {
							// Hide status bar item if it exists
							if (this.plugin.statusBarItem) {
								this.plugin.statusBarItem.remove();
								this.plugin.statusBarItem = null;
							}
						}
					})();
				}));

		new Setting(containerEl)
			.setName(i18n.t('settings.mountRootDeletionBehavior.name'))
			.setDesc(i18n.t('settings.mountRootDeletionBehavior.desc'))
			.addDropdown(drop => drop
				.addOption('ask', i18n.t('settings.mountRootDeletionBehavior.options.ask'))
				.addOption('unmount', i18n.t('settings.mountRootDeletionBehavior.options.unmount'))
				.addOption('delete', i18n.t('settings.mountRootDeletionBehavior.options.delete'))
				.setValue(this.plugin.settings.mountRootDeletionBehavior)
				.onChange((val: 'ask' | 'unmount' | 'delete') => {
					void (async () => {
						this.plugin.settings.mountRootDeletionBehavior = val;
						await this.plugin.saveSettings();
					})();
				})
			);

		new Setting(containerEl)
			.setName(i18n.t('settings.allowForeignMounts.name'))
			.setDesc(i18n.t('settings.allowForeignMounts.desc'))
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.allowForeignMounts)
				.onChange(val => {
					void (async () => {
						this.plugin.settings.allowForeignMounts = val;
						await this.plugin.saveSettings();
						this.renderSync(); // Refresh to update toggle states
					})();
				}));

		new Setting(containerEl)
			.setName(i18n.t('settings.maxDataUriMB.name'))
			.setDesc(i18n.t('settings.maxDataUriMB.desc'))
			.addText(text => text
				.setPlaceholder(i18n.t('settings.maxDataUriMB.placeholder'))
				.setValue(String(this.plugin.settings.maxDataUriMB ?? 10))
				.onChange(val => {
					void (async () => {
						const parsed = parseFloat(val);
						if (!isNaN(parsed) && parsed > 0) {
							this.plugin.settings.maxDataUriMB = parsed;
							await this.plugin.saveSettings();
							this.plugin.virtualAdapter?.setMaxDataUri(parsed * 1024 * 1024);
						}
					})();
				}));

		new Setting(containerEl)
			.setName(i18n.t('settings.support.name', { plugin: pluginName }))
			.setDesc(i18n.t('settings.support.desc'))
			.addButton(btn => btn
				.setButtonText(`GitHub ${ghRepo}`)
				.setTooltip(i18n.t('settings.support.repo.tooltip', { plugin: pluginName }))
				.onClick(() => openExternalUrl(GITHUB_REPO_URL)))
			.addButton(btn => btn
				.setButtonText(`More ${moreProj}`)
				.setTooltip(i18n.t('settings.support.profile.tooltip'))
				.onClick(() => openExternalUrl(GITHUB_PROFILE_URL)))
			.addButton(btn => btn
				.setButtonText(`☕ Buy ${buyMe}`)
				.setTooltip(i18n.t('settings.support.coffee.tooltip'))
				.onClick(() => openExternalUrl(BUY_ME_COFFEE_URL)));

		// ── Extended features ────────────────────────────────────────────
		new Setting(containerEl).setName(i18n.t('settings.extensions')).setHeading();

		new Setting(containerEl)
			.setName(i18n.t('settings.enableMoveCopyMenu.name'))
			.setDesc(i18n.t('settings.enableMoveCopyMenu.desc'))
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableMoveCopyMenu)
				.onChange(val => {
					void (async () => {
						this.plugin.settings.enableMoveCopyMenu = val;
						await this.plugin.saveSettings();
					})();
				}));

		if (this.plugin.settings.enableMountMerging) {
			new Setting(containerEl)
				.setName(i18n.t('settings.vaultPriority.name'))
				.setDesc(i18n.t('settings.vaultPriority.desc'))
				.addText(text => {
					text.inputEl.type = 'number';
					text.inputEl.min = '0';
					text.inputEl.addClass('folderbridge-input-narrow');
					text.setPlaceholder(i18n.t('settings.vaultPriority.placeholder'))
						.setValue(String(this.plugin.settings.vaultPriority ?? 1000))
						.onChange(val => {
							const n = parseInt(val, 10);
							void (async () => {
								this.plugin.settings.vaultPriority = isNaN(n) || n < 0 ? 1000 : n;
								await this.plugin.saveSettings();
								this.plugin.virtualAdapter?.setVaultPriority(this.plugin.settings.vaultPriority);
							})();
						});
				});
			new Setting(containerEl)
				.setName(i18n.t('settings.conflictResolution.name'))
				.setDesc(i18n.t('settings.conflictResolution.desc'))
				.addDropdown(drop => drop
					.addOption('folders-win', i18n.t('settings.conflictResolution.foldersWin'))
					.addOption('files-win', i18n.t('settings.conflictResolution.filesWin'))
					.setValue(this.plugin.settings.conflictResolution ?? 'folders-win')
					.onChange(val => {
						void (async () => {
							this.plugin.settings.conflictResolution = val as 'folders-win' | 'files-win';
							await this.plugin.saveSettings();
							this.plugin.virtualAdapter?.setConflictResolution(this.plugin.settings.conflictResolution);
						})();
					}));
		} else {
			containerEl.createEl('p', {
				text: i18n.t('settings.priorityDisabled'),
				cls: 'setting-item-description',
			});
		}

// Transfer & Creation settings
		new Setting(containerEl)
			.setName(i18n.t('settings.defaultCreationVault.name'))
			.setDesc(i18n.t('settings.defaultCreationVault.desc'))
			.addDropdown(drop => {
				drop.addOption('vault', i18n.t('settings.defaultCreationVault.localVault'));
				drop.addOption('mounts', i18n.t('settings.defaultCreationVault.mounts'));
				drop.setValue(this.plugin.settings.defaultCreationVault ?? 'vault');
				drop.onChange(val => {
					void (async () => {
						this.plugin.settings.defaultCreationVault = val;
						this.plugin.virtualAdapter?.setDefaultCreationVault(val);
						await this.plugin.saveSettings();
					})();
				});
			});

		new Setting(containerEl)
			.setName(i18n.t('settings.enableExplorerHighlight.name'))
			.setDesc(i18n.t('settings.enableExplorerHighlight.desc'))
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableExplorerHighlight)
				.onChange(val => {
					void (async () => {
						this.plugin.settings.enableExplorerHighlight = val;
						await this.plugin.saveSettings();
						if (val) {
							this.plugin.setupExplorerHighlighting();
						} else {
							this.plugin.teardownExplorerHighlighting();
						}
					})();
				}));

		// ── Ignore Lists ─────────────────────────────────────────────────
		new Setting(containerEl).setName(i18n.t('settings.ignoreLists')).setHeading();

		// ── Global ignore patterns ───────────────────────────────────────
		new Setting(containerEl)
			.setName(i18n.t('settings.globalIgnorePatterns.name'))
			.setDesc(i18n.t('settings.globalIgnorePatterns.desc'))
			.setHeading();

		const globalIgnoreContainer = containerEl.createDiv('folderbridge-global-ignore');

		const renderGlobalIgnoreList = () => {
			globalIgnoreContainer.empty();
			const list = this.plugin.settings.globalIgnorePatterns || [];
			if (list.length === 0) {
				globalIgnoreContainer.createEl('p', {
					text: i18n.t('settings.globalIgnorePatterns.empty'),
					cls: 'setting-item-description'
				});
			}
			for (const item of list) {
				const itemEl = globalIgnoreContainer.createDiv('folderbridge-ignore-item');
				itemEl.createSpan({ text: item });
				const removeBtn = itemEl.createEl('button', { text: i18n.t('button.remove') });
				removeBtn.onclick = () => {
					void (async () => {
						this.plugin.settings.globalIgnorePatterns = this.plugin.settings.globalIgnorePatterns.filter(i => i !== item);
						await this.plugin.saveSettings();
						this.plugin.updateIgnoreCachePublic();
						renderGlobalIgnoreList();
					})();
				};
			}
			const addContainer = globalIgnoreContainer.createDiv('folderbridge-ignore-add');
			const inputEl = addContainer.createEl('input', { type: 'text', placeholder: i18n.t('settings.globalIgnorePatterns.placeholder') });
			const addBtn = addContainer.createEl('button', { text: i18n.t('settings.globalIgnorePatterns.add') });
			addBtn.onclick = () => {
				void (async () => {
					const val = inputEl.value.trim();
					if (val) {
						if (!this.plugin.settings.globalIgnorePatterns) this.plugin.settings.globalIgnorePatterns = [];
						if (!this.plugin.settings.globalIgnorePatterns.includes(val)) {
							this.plugin.settings.globalIgnorePatterns.push(val);
							await this.plugin.saveSettings();
							this.plugin.updateIgnoreCachePublic();
							inputEl.value = '';
							renderGlobalIgnoreList();
						}
					}
				})();
			};
			inputEl.addEventListener('keypress', e => { if (e.key === 'Enter') addBtn.click(); });
		};
		renderGlobalIgnoreList();

		// ── Per-mount ignore lists ────────────────────────────────────────
		new Setting(containerEl)
			.setName(i18n.t('settings.perMountIgnoreLists.name'))
			.setDesc(i18n.t('settings.perMountIgnoreLists.desc'))
			.setHeading();

		const editableMounts = this.plugin.settings.mountPoints.filter(m => this.plugin.isUserEditableMount(m));

		if (editableMounts.length === 0) {
			containerEl.createEl('p', {
				text: this.plugin.settings.tocSources.length > 0 || this.plugin.settings.managedTocSource.trim()
					? i18n.t('settings.perMountIgnoreLists.externalHint')
					: i18n.t('settings.perMountIgnoreLists.emptyHint'),
				cls: 'setting-item-description',
			});
		} else {
			// Ensure a valid selection
			if (!this.selectedIgnoreMountId || !editableMounts.find(m => m.id === this.selectedIgnoreMountId)) {
				this.selectedIgnoreMountId = editableMounts[0].id;
			}

			new Setting(containerEl)
				.setName(i18n.t('settings.selectMount.name'))
				.setDesc(i18n.t('settings.selectMount.desc'))
				.addDropdown(drop => {
					for (const m of editableMounts) {
						drop.addOption(m.id, m.label || m.virtualPath);
					}
					drop.setValue(this.selectedIgnoreMountId!);
					drop.onChange(val => {
						this.selectedIgnoreMountId = val;
						this.renderSync(); // Re-render to show the selected mount's list
					});
				});

			const selectedMount = editableMounts.find(m => m.id === this.selectedIgnoreMountId);
			if (selectedMount) {
				const ignoreListContainer = containerEl.createDiv('folderbridge-ignore-list');

				const renderIgnoreList = () => {
					ignoreListContainer.empty();

					const list = selectedMount.ignoreList || [];
					if (list.length === 0) {
						ignoreListContainer.createEl('p', { text: i18n.t('ignore.list.empty'), cls: 'setting-item-description' });
					}

					for (const item of list) {
						const itemEl = ignoreListContainer.createDiv('folderbridge-ignore-item');
						itemEl.createSpan({ text: item });

						const removeBtn = itemEl.createEl('button', { text: i18n.t('button.remove') });
						removeBtn.onclick = () => {
							void (async () => {
								selectedMount.ignoreList = selectedMount.ignoreList!.filter(i => i !== item);
								await this.plugin.persistEditableMountFromState(selectedMount);
								renderIgnoreList();
							})();
						};
					}

					const addContainer = ignoreListContainer.createDiv('folderbridge-ignore-add');

					const inputEl = addContainer.createEl('input', { type: 'text', placeholder: i18n.t('ignore.list.placeholder') });

					// Browse mount button — opens disk picker rooted at the mount's real path
					// Multi-select: all chosen folders are added to the ignore list immediately.
					const browseBtn = addContainer.createEl('button', { text: i18n.t('ignore.list.browse') });
					browseBtn.setAttribute('title', i18n.t('ignore.list.multiSelectHint', { ctrlCmd }));
					browseBtn.onclick = () => {
						void (async () => {
							const selections = await browseMultipleFoldersOnDisk(
								i18n.t('ignore.list.browseTitle', { mount: selectedMount.label || selectedMount.virtualPath }),
								selectedMount.realPath,
							);
							if (!selections?.length) return;

							const mountReal = selectedMount.realPath.replace(/\\/g, '/').replace(/\/$/, '');
							if (!selectedMount.ignoreList) selectedMount.ignoreList = [];

							let added = 0;
							for (const selected of selections) {
								const sel = selected.replace(/\\/g, '/').replace(/\/$/, '');
								const relative = sel.startsWith(mountReal + '/')
									? sel.slice(mountReal.length + 1)
									: sel;
								if (!selectedMount.ignoreList.includes(relative)) {
									selectedMount.ignoreList.push(relative);
									added++;
								}
							}

							if (added > 0) {
								await this.plugin.persistEditableMountFromState(selectedMount);
								await this.plugin.applyIgnoreListToVault(selectedMount);
								renderIgnoreList();
								new Notice(i18n.t('ignore.list.added', { count: added, plural: added === 1 ? '' : 's' }));
							}
						})();
					};

					const addBtn = addContainer.createEl('button', { text: i18n.t('ignore.list.add') });
					addBtn.onclick = () => {
						void (async () => {
							const val = inputEl.value.trim();
							if (val) {
								if (!selectedMount.ignoreList) selectedMount.ignoreList = [];
								if (!selectedMount.ignoreList.includes(val)) {
									selectedMount.ignoreList.push(val);
									await this.plugin.persistEditableMountFromState(selectedMount);
									// Rebuild cache and remove newly-ignored items from the file explorer
									await this.plugin.applyIgnoreListToVault(selectedMount);
									inputEl.value = '';
									renderIgnoreList();
								}
							}
						})();
					};

					inputEl.addEventListener('keypress', (e) => {
						if (e.key === 'Enter') {
							addBtn.click();
						}
					});
				};

				renderIgnoreList();
			}
		}

		// ── Managed TOC file ───────────────────────────────────────────────
		new Setting(containerEl)
			.setName(i18n.t('toc.manage.name'))
			.setDesc(i18n.t('toc.manage.desc'))
			.setHeading();

		const managedTocContainer = containerEl.createDiv('folderbridge-toc-sources');
		const renderManagedToc = () => {
			managedTocContainer.empty();
			const currentPath = this.plugin.settings.managedTocSource.trim();
			const currentFallbackPath = this.plugin.settings.managedTocSourceFallback?.trim() ?? '';
			const suggestedPath = this.plugin.getSuggestedManagedTocPath();
			managedTocContainer.createEl('p', {
				text: currentPath
					? i18n.t('toc.manage.current', { path: currentPath })
					: i18n.t('toc.manage.none'),
				cls: 'setting-item-description',
			});
			const resolvedToc = this.plugin.resolvedManagedTocSource;
			if (currentFallbackPath && resolvedToc === currentFallbackPath && resolvedToc !== currentPath) {
				managedTocContainer.createEl('p', {
					text: i18n.t('toc.manage.fallbackActive', { path: resolvedToc }),
					cls: 'setting-item-description',
				});
			}
			if (!currentPath && suggestedPath) {
				managedTocContainer.createEl('p', {
					text: i18n.t('toc.manage.suggested', { path: suggestedPath }),
					cls: 'setting-item-description',
				});
			}

			const addRow = managedTocContainer.createDiv('folderbridge-ignore-add');
			const inputEl = addRow.createEl('input', {
				type: 'text',
				placeholder: i18n.t('toc.manage.placeholder'),
			});
			inputEl.value = currentPath || suggestedPath || '';

			const fallbackRow = managedTocContainer.createDiv('folderbridge-ignore-add');
			fallbackRow.createEl('span', { text: i18n.t('toc.manage.fallbackLabel'), cls: 'setting-item-description' });
			const fallbackInputEl = fallbackRow.createEl('input', {
				type: 'text',
				placeholder: i18n.t('toc.manage.fallbackPlaceholder'),
			});
			fallbackInputEl.value = currentFallbackPath;
			const saveFallback = () => {
				void (async () => {
					this.plugin.settings.managedTocSourceFallback = fallbackInputEl.value.trim();
					await this.plugin.resolveAndCacheManagedTocSource();
					await this.plugin.saveSettings();
					this.renderSync();
				})();
			};
			fallbackInputEl.addEventListener('change', saveFallback);
			const fallbackBrowseBtn = fallbackRow.createEl('button', { text: i18n.t('button.browse') });
			fallbackBrowseBtn.onclick = () => {
				void (async () => {
					const selected = await browseFolderOnDisk(i18n.t('toc.manage.fallbackBrowseTitle'));
					if (!selected || !path) return;
					const filename = currentPath ? path.win32.basename(currentPath) : 'folderbridge.managed.json';
					fallbackInputEl.value = path.join(selected, filename);
				})();
			};
			const fallbackSaveBtn = fallbackRow.createEl('button', { text: i18n.t('toc.manage.setFallback') });
			fallbackSaveBtn.onclick = saveFallback;

			const saveBtn = addRow.createEl('button', { text: currentPath ? i18n.t('toc.manage.rebind') : i18n.t('toc.manage.set') });
			saveBtn.onclick = () => {
				void (async () => {
					if (await this.plugin.bindManagedTocSource(inputEl.value)) {
						this.renderSync();
					}
				})();
			};

			if (!currentPath) {
				const createBtn = addRow.createEl('button', { text: i18n.t('toc.manage.createFromUi') });
				createBtn.onclick = () => {
					void (async () => {
						const result = await this.plugin.createManagedTocFromCurrentMounts(inputEl.value);
						if (!result.success || !result.targetPath) return;
						if (result.moved > 0 || result.skipped > 0) {
							new Notice(i18n.t('toc.manage.createdMoved', {
								path: result.targetPath,
								moved: result.moved,
								plural: result.moved === 1 ? '' : 's',
								skipped: result.skipped > 0 ? i18n.t('toc.manage.skippedCloud', { skipped: result.skipped }) : '',
							}));
						} else {
							new Notice(i18n.t('toc.manage.created', { path: result.targetPath }));
						}
						this.renderSync();
					})();
				};
			}

			if (currentPath) {
				const clearBtn = addRow.createEl('button', { text: i18n.t('button.disable') });
				clearBtn.onclick = () => {
					void (async () => {
						await this.plugin.unbindManagedTocSource();
						this.renderSync();
					})();
				};

				const migrateBtn = addRow.createEl('button', { text: i18n.t('toc.manage.migrate') });
				migrateBtn.onclick = () => {
					void (async () => {
						const result = await this.plugin.migrateLocalManualMountsToManagedToc();
						if (result.moved > 0 || result.skipped > 0) {
							new Notice(i18n.t('toc.manage.migrated', {
								moved: result.moved,
								plural: result.moved === 1 ? '' : 's',
								skipped: result.skipped > 0 ? i18n.t('toc.manage.skippedCloud', { skipped: result.skipped }) : '',
							}));
						} else {
							new Notice(i18n.t('toc.manage.nothingToMigrate'));
						}
						this.renderSync();
					})();
				};
			}
		};
		renderManagedToc();

		// ── External TOC config files ─────────────────────────────────────
		new Setting(containerEl)
			.setName(i18n.t('toc.external.name'))
			.setDesc(i18n.t('toc.external.desc'))
			.setHeading();

		const tocInfo = containerEl.createEl('p', {
			text: i18n.t('toc.external.note'),
			cls: 'setting-item-description',
		});
		tocInfo.addClass('folderbridge-setting-note');

		const tocWarnings = this.plugin.getTocWarnings();
		if (tocWarnings.length > 0) {
			const warningList = containerEl.createEl('ul', { cls: 'setting-item-description' });
			for (const warning of tocWarnings) {
				warningList.createEl('li', { text: warning });
			}
		}

		const tocContainer = containerEl.createDiv('folderbridge-toc-sources');
		const renderTocSources = () => {
			tocContainer.empty();
			if (this.plugin.settings.tocSources.length === 0) {
				tocContainer.createEl('p', {
					text: i18n.t('toc.external.none'),
					cls: 'setting-item-description',
				});
			}

			for (const source of this.plugin.settings.tocSources) {
				const row = tocContainer.createDiv('folderbridge-ignore-item');
				row.createSpan({ text: source });
				const removeBtn = row.createEl('button', { text: i18n.t('button.remove') });
				removeBtn.onclick = () => {
					void (async () => {
						this.plugin.settings.tocSources = this.plugin.settings.tocSources.filter(item => item !== source);
						await this.plugin.refreshTocMountSources(true);
						await this.plugin.saveSettings();
						this.renderSync();
					})();
				};
			}

			const addRow = tocContainer.createDiv('folderbridge-ignore-add');
			const inputEl = addRow.createEl('input', {
				type: 'text',
				placeholder: i18n.t('toc.external.placeholder'),
			});
			const addBtn = addRow.createEl('button', { text: i18n.t('toc.external.add') });
			addBtn.onclick = () => {
				void (async () => {
					const value = inputEl.value.trim();
					if (!value || this.plugin.settings.tocSources.includes(value)) return;
					this.plugin.settings.tocSources.push(value);
					await this.plugin.refreshTocMountSources(true);
					await this.plugin.saveSettings();
					inputEl.value = '';
					this.renderSync();
				})();
			};
			inputEl.addEventListener('keypress', event => {
				if (event.key === 'Enter') addBtn.click();
			});
		};
		renderTocSources();

		// ── Mount points ─────────────────────────────────────────────────
		new Setting(containerEl).setName(i18n.t('settings.mountPoints')).setHeading();

		// ── Mount list sort order ────────────────────────────────────────
		if (this.plugin.settings.enableMountMerging) {
			new Setting(containerEl)
				.setName(i18n.t('settings.mountListSort.name'))
				.setDesc(i18n.t('settings.mountListSort.desc'))
				.addDropdown(drop => drop
					.addOption('default', i18n.t('settings.mountListSort.options.default'))
					.addOption('name-asc', i18n.t('settings.mountListSort.options.nameAsc'))
					.addOption('name-desc', i18n.t('settings.mountListSort.options.nameDesc'))
					.addOption('priority-desc', i18n.t('settings.mountListSort.options.priorityDesc'))
					.addOption('priority-asc', i18n.t('settings.mountListSort.options.priorityAsc'))
					.setValue(this.plugin.settings.mountListSort ?? 'default')
					.onChange(val => {
						void (async () => {
							this.plugin.settings.mountListSort = val as typeof this.plugin.settings.mountListSort;
							await this.plugin.saveSettings();
							this.renderSync();
						})();
					}));
		}

		new Setting(containerEl)
			.setName(i18n.t('settings.addMount.name'))
			.setDesc(i18n.t('settings.addMount.desc'))
			.addButton(btn => btn
				.setButtonText(i18n.t('settings.addMount.button'))
				.setCta()
				.onClick(() => {
					new MountManagerModal(
						this.app,
						this.plugin.manifest.name,
						this.plugin.security,
						async (mount) => {
							await this.plugin.addMount(mount);
							this.renderSync();
						},
					).open();
				}))
			.addButton(btn => btn
				.setButtonText(i18n.t('button.export'))
				.setTooltip(i18n.t('button.export.tooltip'))
				.onClick(() => {
					const manualMounts = this.plugin.settings.mountPoints.filter(m => this.plugin.isUserEditableMount(m));
					// Strip secrets before exporting
					const exportData = {
						version: '1',
						exportedAt: new Date().toISOString(),
						mountPoints: manualMounts.map(m => {
							// Strip all stored credentials — device-specific and useless on other machines.
							// JSON.stringify omits undefined values, so these fields are excluded from export.
							return {
								...m,
								encryptedWebdavPassword: undefined,
								webdavPassword: undefined,
								encryptedS3SecretKey: undefined,
								s3SecretKey: undefined,
								encryptedSftpPassword: undefined,
								sftpPassword: undefined,
								encryptedSftpPassphrase: undefined,
								sftpPassphrase: undefined,
							};
						}),
					};
					const blob = new Blob([JSON.stringify(exportData, null, '\t')], { type: 'application/json' });
					const url = URL.createObjectURL(blob);
					const a = document.createElement('a');
					a.href = url;
					a.download = 'folderbridge-mounts.json';
					a.click();
					URL.revokeObjectURL(url);
				}))
			.addButton(btn => btn
				.setButtonText(i18n.t('button.import'))
				.setTooltip(i18n.t('button.import.tooltip'))
				.onClick(() => {
					const input = document.createElement('input');
					input.type = 'file';
					input.accept = '.json,application/json';
					input.onchange = () => {
						void (async () => {
							const file = input.files?.[0];
							if (!file) return;
							try {
								const text = await file.text();
								const parsed = JSON.parse(text) as unknown;
								const parsedMounts = Array.isArray(parsed)
									? parsed
									: (parsed as Record<string, unknown>).mountPoints;
								const mounts = Array.isArray(parsedMounts) ? parsedMounts as MountPoint[] : [];
							if (!Array.isArray(mounts) || mounts.length === 0) {
								new Notice(i18n.t('import.noMounts'));
								return;
							}

								let added = 0, skipped = 0;
								for (const m of mounts) {
									if (typeof m.virtualPath !== 'string' || typeof m.realPath !== 'string') {
										skipped++; continue;
									}
									// Assign fresh ID and current device unless file already has a matching one
									const fresh: MountPoint = {
										...m,
										id: generateId(),
										deviceId: this.plugin.settings.deviceId,
										// Strip all stored credentials so the imported mount
										// doesn't carry encrypted blobs that can't be decrypted on this device.
										encryptedWebdavPassword: undefined,
										webdavPassword: undefined,
										encryptedS3SecretKey: undefined,
										s3SecretKey: undefined,
										encryptedSftpPassword: undefined,
										sftpPassword: undefined,
										encryptedSftpPassphrase: undefined,
										sftpPassphrase: undefined,
									};
									await this.plugin.addMount(fresh);
									added++;
								}
								new Notice(i18n.t('import.summary', {
									added,
									plural: added === 1 ? '' : 's',
									skipped: skipped > 0 ? i18n.t('import.skippedInvalid', { skipped }) : '',
								}));
								this.renderSync();
							} catch {
								new Notice(i18n.t('import.failed'));
							}
						})();
					};
					input.click();
				}));

		// Render each existing mount (status loaded async below)
		if (this.plugin.settings.mountPoints.length === 0) {
			containerEl.createEl('p', {
				text: i18n.t('settings.noMounts'),
				cls: 'setting-item-description',
			});
		} else {
			// Warn about duplicate priorities
			const priorityGroups = new Map<number, MountPoint[]>();
			for (const m of this.plugin.settings.mountPoints) {
				const p = m.priority ?? 0;
				if (!priorityGroups.has(p)) priorityGroups.set(p, []);
				priorityGroups.get(p)!.push(m);
			}
			const dupes = [...priorityGroups.entries()].filter(([, arr]) => arr.length > 1);
			if (dupes.length > 0) {
				containerEl.createEl('p', {
					text: i18n.t('settings.priorityWarning', { count: dupes.length }),
					cls: 'setting-item-description folderbridge-priority-warning',
				});
			}
		}

		// Sort mounts before rendering
		const sortMode = this.plugin.settings.mountListSort ?? 'default';
		let sortedMounts = [...this.plugin.settings.mountPoints];
		if (sortMode !== 'default') {
			sortedMounts = sortedMounts.sort((a, b) => {
				const nameA = (a.label || a.virtualPath).toLowerCase();
				const nameB = (b.label || b.virtualPath).toLowerCase();
				const prioA = a.priority ?? 0;
				const prioB = b.priority ?? 0;
				if (sortMode === 'name-asc') return nameA.localeCompare(nameB);
				if (sortMode === 'name-desc') return nameB.localeCompare(nameA);
				if (sortMode === 'priority-desc') return prioB - prioA;
				if (sortMode === 'priority-asc') return prioA - prioB;
				return 0;
			});
		}

		// Wrap mount rows in a container so drag-drop only affects this list
		const mountListEl = containerEl.createDiv('folderbridge-mount-list');
		for (const mount of sortedMounts) {
			this.renderMountRow(mountListEl, mount);
		}
	}

	/** Render a single mount row synchronously, then patch status asynchronously. */
	private renderMountRow(containerEl: HTMLElement, mount: MountPoint): void {
		const isThisDevice = mount.deviceId === this.plugin.settings.deviceId;
		const canEnable = this.plugin.isMountEnabledOnThisDevice(mount);
		const isTocManaged = this.plugin.isTocManagedMount(mount);
		const isManagedToc = this.plugin.isManagedTocMount(mount);
		const isUserEditable = this.plugin.isUserEditableMount(mount);
		const displayName = mount.label || mount.virtualPath;

		const mountPriority = mount.priority ?? 0;
		let desc = `${normalizePath(mount.virtualPath)} → ${mount.realPath}  [${i18n.t('mountRow.priority')}: ${mountPriority}]`;
		if (mount.fallbackRealPath) {
			desc += ` (${i18n.t('mountRow.fallbackPath')}: ${mount.fallbackRealPath})`;
		}
		if (isTocManaged) {
			desc += isManagedToc
				? ` (${i18n.t('mountRow.managedToc')}: ${mount.tocSourcePath})`
				: ` (${i18n.t('mountRow.externalConfig')}: ${mount.tocSourcePath})`;
		}
		if (!isThisDevice) {
			desc += ` (${i18n.t('mountRow.createdOnDevice')}: ${mount.deviceId?.substring(0, 8) || 'unknown'})`;
		}

		const effectivePath = this.plugin.pathMapper.getEffectiveRealPath(mount);
		if (effectivePath !== mount.realPath) {
			desc += mount.deviceOverrides?.[this.plugin.settings.deviceId] === effectivePath
				? ` (${i18n.t('mountRow.pathOverride')}: ${effectivePath})`
				: ` (${i18n.t('mountRow.usingFallback')}: ${effectivePath})`;
		}

		// Tags as plain text
		if (mount.tags && mount.tags.length > 0) {
			const tagsStr = mount.tags.map(t => `#${t}`).join(', ');
			desc += ` [${i18n.t('mountRow.tags')}: ${tagsStr}]`;
		}

		const setting = new Setting(containerEl)
			.setName(`${displayName}`)
			.setDesc(desc)
			.addToggle(toggle => {
				toggle
					.setValue(mount.enabled)
					.setTooltip(
						!isUserEditable
							? i18n.t('mountRow.tooltip.externalManaged')
							: (canEnable ? i18n.t('mountRow.tooltip.toggle') : i18n.t('mountRow.tooltip.foreignDevice'))
					)
					.onChange(val => {
						void (async () => {
							if (!isUserEditable) {
								toggle.setValue(mount.enabled);
								new Notice(i18n.t('mountRow.notice.externalManaged'));
								return;
							}
							if (!canEnable) {
								// Revert the toggle visually if they try to enable a foreign mount
								toggle.setValue(false);
								new Notice(i18n.t('mountRow.notice.foreignDevice'));
								return;
							}

							// [BUGFIX_20260222] Fix UI refresh bug when unmounting
							// We must call notifyVaultMountRemoved BEFORE updating pathMapper
							// so that adapter.list() can still resolve the virtual paths to real paths
							// and find the files to remove from Obsidian's internal fileMap.
							if (!val) {
								await this.plugin.notifyVaultMountRemoved(mount);
							}

							mount.enabled = val;
							await this.plugin.persistEditableMountFromState(mount);
							this.plugin.pathMapper.update(this.plugin.settings.mountPoints, this.plugin.settings.deviceId);
							this.plugin.updateStatusBar();

							// Inject into Obsidian's vault tree live
							if (val) {
								await this.plugin.notifyVaultMountAdded(mount);
							}
						})();
					});

				// Disable the toggle entirely if it's not this device and foreign mounts aren't allowed
				if (!canEnable || !isUserEditable) {
					toggle.toggleEl.classList.add('is-disabled', 'folderbridge-toggle-disabled');
				}
			})
			.addExtraButton(btn => {
				// Read-only lock icon — click to toggle; always visible so state is obvious at a glance
				btn
					.setIcon(mount.readOnly ? 'lock' : 'unlock')
					.setTooltip(
						!isUserEditable
							? i18n.t('mountRow.tooltip.externalReadOnly')
							: (mount.readOnly ? i18n.t('mountRow.tooltip.readOnly') : i18n.t('mountRow.tooltip.writable'))
					)
					.onClick(() => {
						void (async () => {
							if (!isUserEditable) {
								new Notice(i18n.t('mountRow.notice.externalManaged'));
								return;
							}
							await this.plugin.setMountReadOnly(mount.id, !mount.readOnly);
							this.renderSync();
						})();
					});
				if (mount.readOnly) {
					btn.extraSettingsEl.classList.add('folderbridge-warning-icon');
				}
			});

		const addOverridePathButton = (): void => {
			setting.addButton(btn => btn
				.setButtonText(i18n.t('mountRow.usePathOnDevice'))
				.setTooltip(i18n.t('mountRow.usePathOnDevice.tooltip'))
				.onClick(() => {
					void (async () => {
						const newPath = await browseFolderOnDisk(i18n.t('mountRow.selectRealFolder'));
						if (newPath) {
							await this.plugin.setDeviceOverride(mount.id, newPath);
							this.renderSync();
							new Notice(i18n.t('mountRow.notice.pathOverridden'));
						}
					})();
				}));
		};

		if (!isThisDevice && isUserEditable) {
			addOverridePathButton();
		}

		// Edit button — opens the modal pre-populated with this mount's values
		if (isThisDevice && isUserEditable) {
			setting.addButton(btn => btn
				.setButtonText(i18n.t('button.edit'))
				.setTooltip(i18n.t('mountRow.edit.tooltip'))
				.onClick(() => {
					new MountManagerModal(
						this.app,
						this.plugin.manifest.name,
						this.plugin.security,
						async (updatedData, editId) => {
							if (editId) {
								await this.plugin.updateMount(editId, updatedData);
							}
							this.renderSync();
						},
						mount, // pre-populate all fields
					).open();
				}));
		}

		if (isUserEditable) {
			setting.addButton(btn => {
				btn.setButtonText(i18n.t('button.remove'))
					.onClick(() => {
						void (async () => {
							await this.plugin.removeMount(mount.id);
							this.renderSync();
						})();
					});
				if (typeof btn.setDestructive === 'function') {
					btn.setDestructive();
				} else {
					btn.setClass('mod-warning');
				}
			});
		}

		// ── Drag-drop reordering ────────────────────────────────────────────
		const el = setting.settingEl;
		const allowReorder = this.plugin.settings.tocSources.length === 0 && !this.plugin.settings.managedTocSource.trim() && !isTocManaged;
		if (allowReorder) {
			el.setAttribute('draggable', 'true');
			el.dataset.mountId = mount.id;
			el.addClass('folderbridge-draggable-row');
		}

		el.addEventListener('dragstart', (e) => {
			if (!allowReorder) return;
			this.dragSrcId = mount.id;
			el.addClass('folderbridge-drag-source');
			e.dataTransfer?.setData('text/plain', mount.id);
		});

		el.addEventListener('dragend', () => {
			if (!allowReorder) return;
			this.dragSrcId = null;
			el.removeClass('folderbridge-drag-source');
			containerEl.querySelectorAll('.folderbridge-drag-over')
				.forEach(n => (n as HTMLElement).removeClass('folderbridge-drag-over'));
		});

		el.addEventListener('dragover', (e) => {
			if (!allowReorder) return;
			if (this.dragSrcId && this.dragSrcId !== mount.id) {
				e.preventDefault();
				containerEl.querySelectorAll('.folderbridge-drag-over')
					.forEach(n => (n as HTMLElement).removeClass('folderbridge-drag-over'));
				el.addClass('folderbridge-drag-over');
			}
		});

		el.addEventListener('dragleave', (e) => {
			if (!allowReorder) return;
			if (!el.contains(e.relatedTarget as Node)) {
				el.removeClass('folderbridge-drag-over');
			}
		});

		el.addEventListener('drop', (e) => {
			if (!allowReorder) return;
			e.preventDefault();
			el.removeClass('folderbridge-drag-over');
			if (!this.dragSrcId || this.dragSrcId === mount.id) return;

			const mounts = this.plugin.settings.mountPoints;
			const srcIdx = mounts.findIndex(m => m.id === this.dragSrcId);
			const dstIdx = mounts.findIndex(m => m.id === mount.id);
			if (srcIdx === -1 || dstIdx === -1) return;

			const [moved] = mounts.splice(srcIdx, 1);
			mounts.splice(dstIdx, 0, moved);

			void this.plugin.saveSettings().then(() => this.renderSync());
		});

		// ── Reconnect button (shown immediately when mount is known unreachable) ────
		if (canEnable && this.plugin.mountHealthMap.get(mount.id) === false) {
			setting.addButton(btn => btn
				.setButtonText(i18n.t('button.reconnect'))
				.onClick(() => {
					void (async () => {
						await this.plugin.reconnectMount(mount);
						this.renderSync();
					})();
				}));
		}

		// ── Async status badge ───────────────────────────────────────────────
		if (canEnable) {
			void getMountStatus(mount).then(status => {
				const isUnreachable = this.plugin.mountHealthMap.get(mount.id) === false;
				const badge = isUnreachable
					? '[unreachable]'
					: status.reachable
						? (status.readOnly ? '[read-only]' : '[writable]')
						: `[error: ${status.error ?? 'unreachable'}]`;
				const prefix = (isUnreachable || !status.reachable) ? '✗' : '✓';
				setting.setName(`${prefix} ${displayName} ${badge}`);
				if (isUnreachable || !status.reachable) {
					setting.settingEl.classList.add('folderbridge-unreachable-row');
				}
			}).catch(() => { /* ignore render errors */ });
		} else {
			setting.setName(`[Other device] ${displayName}`);
			setting.settingEl.classList.add('folderbridge-foreign-mount');
		}
	}
}
