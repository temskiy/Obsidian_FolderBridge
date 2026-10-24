import { App, ButtonComponent, Modal, Notice, Platform, Setting, SuggestModal, TFolder, TextComponent, normalizePath } from 'obsidian';
import { MountPoint, MountStatus, MountType } from '../types';
import { SecurityManager } from '../SecurityManager';
import { checkPathAccessible, isDirectory, getPlatform, isWSL } from '../OSHelpers';
import { logger } from '../logger';
import { getRuntimeRequire, loadOptionalNodeModule } from '../runtimeNode';
import { SubmitStateController } from './SubmitStateController';
import { shouldUseFolderNameAsLabel } from './mountLabel';
import { i18n } from '../i18n';

// Lazy-loaded — unavailable on Obsidian Mobile (Capacitor).
const path: typeof import('path') = loadOptionalNodeModule<typeof import('path')>('path') ?? null as never;

/** Minimal interface for Electron's dialog module. */
interface ElectronDialog {
	showOpenDialog(options: ElectronOpenDialogOptions): Promise<{ canceled: boolean; filePaths: string[] }>;
}

interface ElectronModule {
	dialog?: ElectronDialog;
	remote?: {
		dialog?: ElectronDialog;
	};
}

/** Options for Electron's dialog.showOpenDialog. */
interface ElectronOpenDialogOptions {
	properties: string[];
	title?: string;
	defaultPath?: string;
}

// ---------------------------------------------------------------------------
// Electron folder-picker helper
// ---------------------------------------------------------------------------

/**
 * Open the native OS folder-picker dialog via Electron's remote API.
 * Returns the selected absolute path, or null if the user cancelled or the
 * Electron remote API is unavailable in the current host environment.
 */
export async function browseFolderOnDisk(title = i18n.t('mountManager.selectFolder'), defaultPath?: string): Promise<string | null> {
	try {
		const runtimeRequire = getRuntimeRequire();
		const electron = runtimeRequire?.('electron') as ElectronModule | undefined;
		// Electron ≥ 14 ships remote via @electron/remote; Obsidian re-exports
		// it on the electron object so both old and new versions work here.
		const dialog: ElectronDialog | undefined = electron?.remote?.dialog ?? electron?.dialog;
		if (!dialog?.showOpenDialog) {
			new Notice(i18n.t('mountManager.browserUnavailable'));
			return null;
		}
		const options: ElectronOpenDialogOptions = {
			properties: ['openDirectory'],
			title,
		};
		if (defaultPath) {
			options.defaultPath = defaultPath;
		}
		const result = await dialog.showOpenDialog(options);
		if (result.canceled || !result.filePaths?.length) return null;
		return result.filePaths[0];
	} catch (err) {
		logger.error('Folder Bridge: Electron dialog error', err);
		new Notice(i18n.t('mountManager.browserUnavailable'));
		return null;
	}
}

/**
 * Open the native OS folder-picker dialog with multi-selection enabled.
 * Returns the array of selected absolute paths, or null if the user cancelled
 * or the Electron remote API is unavailable.
 */
export async function browseMultipleFoldersOnDisk(title = i18n.t('mountManager.selectFolders'), defaultPath?: string): Promise<string[] | null> {
	try {
		const runtimeRequire = getRuntimeRequire();
		const electron = runtimeRequire?.('electron') as ElectronModule | undefined;
		const dialog: ElectronDialog | undefined = electron?.remote?.dialog ?? electron?.dialog;
		if (!dialog?.showOpenDialog) {
			new Notice(i18n.t('mountManager.browserUnavailable'));
			return null;
		}
		const options: ElectronOpenDialogOptions = {
			properties: ['openDirectory', 'multiSelections'],
			title,
		};
		if (defaultPath) {
			options.defaultPath = defaultPath;
		}
		const result = await dialog.showOpenDialog(options);
		if (result.canceled || !result.filePaths?.length) return null;
		return result.filePaths;
	} catch (err) {
		logger.error('Folder Bridge: Electron dialog error', err);
		new Notice(i18n.t('mountManager.browserUnavailable'));
		return null;
	}
}

// ---------------------------------------------------------------------------
// Vault folder picker modal
// ---------------------------------------------------------------------------

/**
 * A fuzzy-search modal that lists all TFolder nodes currently loaded in the
 * vault.  Used so the user can browse the vault hierarchy when choosing a
 * virtual parent path, rather than having to type it from memory.
 */
export class VaultFolderPickerModal extends SuggestModal<string> {
	private onChoose: (folderPath: string) => void | Promise<void>;
	private folders: string[];

	constructor(app: App, onChoose: (folderPath: string) => void | Promise<void>) {
		super(app);
		this.onChoose = onChoose;
		this.setPlaceholder(i18n.t('mountManager.vaultPlaceholder'));
		// Build the folder list once so getSuggestions only filters, never enumerates
		this.folders = app.vault.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder && f.path.length > 0)
			.map(f => f.path);
	}

	getSuggestions(query: string): string[] {
		const q = query.toLowerCase();
		const results: string[] = [];
		const rootLabel = i18n.t('vaultBrowser.root');

		// Always offer the root as first option
		if (!q || rootLabel.toLowerCase().includes(q)) {
			results.push(rootLabel);
		}

		for (const p of this.folders) {
			if (!q || p.toLowerCase().includes(q)) {
				results.push(p);
			}
		}
		return results;
	}

	renderSuggestion(item: string, el: HTMLElement): void {
		const container = el.createEl('div', { cls: 'vault-folder-suggestion' });

		if (item === i18n.t('vaultBrowser.root')) {
			container.addClass('vault-folder-suggestion-root');
			container.createSpan({ text: item, cls: 'vault-folder-suggestion-label' });
		} else {
			container.createSpan({ text: item, cls: 'vault-folder-suggestion-label' });
		}
	}

	onChooseSuggestion(item: string): void {
		void Promise.resolve(this.onChoose(item === i18n.t('vaultBrowser.root') ? '' : item)).catch(error => {
			logger.error('Folder Bridge: Vault folder picker callback failed', error);
		});
	}
}

// ---------------------------------------------------------------------------
// Callback type
// ---------------------------------------------------------------------------

/** Callback invoked by the modal when the user successfully validates a mount. */
export type OnMountSave = (mount: Omit<MountPoint, 'id'>, editId?: string) => Promise<void>;
type MountManagerInitialValues = Partial<Pick<MountPoint, 'mountType' | 'virtualPath' | 'realPath' | 'label' | 'readOnly'>>;

// ---------------------------------------------------------------------------
// MountManagerModal
// ---------------------------------------------------------------------------

/**
 * MountManagerModal lets the user configure a new mount point:
 *
 *  1. Real path  – absolute OS path, with a native "Browse…" folder picker
 *  2. Virtual path – vault-relative path, with a "Browse vault…" picker that
 *     shows existing vault folders for easy nesting
 *  3. Use folder name as label – auto-fills the label from the real path's
 *     base name whenever the real path changes (can still be overridden)
 *  4. Label – optional display name shown in settings instead of the path
 *  5. Read-only – block all writes through this mount
 */
export class MountManagerModal extends Modal {
	private pluginName: string;
	private onSave: OnMountSave;
	private security: SecurityManager;
	private editMount: MountPoint | undefined;

	// ── Form state ──────────────────────────────────────────────────────────
	private mountType: MountType = 'local';
	private virtualPath = '';
	private realPath = '';
	private fallbackRealPath = '';
	private readOnly = false;
	private label = '';
	private priority = 100;
	private addCommand = false;
	private useFolderNameAsLabel = false;
	// WebDAV fields (password never persisted to data.json)
	private webdavUrl = '';
	private webdavUsername = '';
	private webdavPassword = '';
	// S3 / Backblaze B2 fields
	private s3Bucket = '';
	private s3Region = '';
	private s3Endpoint = '';
	private s3AccessKeyId = '';
	private s3SecretKey = '';
	private s3ForcePathStyle = false;
	private s3Prefix = '/';
	// SFTP fields
	private sftpHost = '';
	private sftpPort = 22;
	private sftpUsername = '';
	private sftpPassword = '';
	private sftpPrivateKeyPath = '';
	private sftpPassphrase = '';
	// Advanced (per-mount watcher + performance)
	private watcherDebounceMs: number | undefined = undefined;
	private watcherUsePolling = false;
	private watcherPollingIntervalMs: number | undefined = undefined;
	private visibleFileFilter: 'all' | 'markdown-only' | 'pdf-only' = 'all';
	private watcherCreateFilter: 'all' | 'markdown-only' = 'all';
	private watcherSuppressAllEvents = false;
	private maxFiles: number | undefined = undefined;
	// Tags for grouping mounts
	private tags: string[] = [];
	// Large file transfer confirmation
	private enableLargeFileConfirm = false;
	private largeFileThresholdKB: number | undefined = undefined;
	// Explorer highlight color
	private highlightColor = '';

	// ── Component references for programmatic updates ────────────────────────
	private virtualPathText: TextComponent | null = null;
	private realPathText: TextComponent | null = null;
	private labelText: TextComponent | null = null;
	private saveButton: ButtonComponent | null = null;
	private cancelButton: ButtonComponent | null = null;
	private readonly submitState: SubmitStateController;

	constructor(
		app: App,
		pluginName: string,
		security: SecurityManager,
		onSave: OnMountSave,
		editMount?: MountPoint,
		initialValues?: MountManagerInitialValues,
	) {
		super(app);
		this.pluginName = pluginName;
		this.security = security;
		this.onSave = onSave;
		this.editMount = editMount;
		this.submitState = new SubmitStateController(
			editMount ? i18n.t('mountManager.submit.save') : i18n.t('mountManager.submit.add'),
			editMount ? i18n.t('mountManager.submit.saving') : i18n.t('mountManager.submit.adding'),
		);
		// Pre-populate state from existing mount
		if (editMount) {
			this.mountType = editMount.mountType ?? 'local';
			this.virtualPath = editMount.virtualPath;
			this.realPath = editMount.realPath;
			this.fallbackRealPath = editMount.fallbackRealPath ?? '';
			this.readOnly = editMount.readOnly;
			this.label = editMount.label ?? '';
			this.priority = editMount.priority ?? 100;
			this.addCommand = editMount.addCommand ?? false;
			this.useFolderNameAsLabel = shouldUseFolderNameAsLabel(this.realPath, this.label);
			// WebDAV
			this.webdavUrl = editMount.webdavUrl ?? '';
			this.webdavUsername = editMount.webdavUsername ?? '';
			// Password is never stored — leave blank; user re-enters to change
			// S3
			this.s3Bucket = editMount.s3Bucket ?? '';
			this.s3Region = editMount.s3Region ?? '';
			this.s3Endpoint = editMount.s3Endpoint ?? '';
			this.s3AccessKeyId = editMount.s3AccessKeyId ?? '';
			this.s3ForcePathStyle = editMount.s3ForcePathStyle ?? false;
			this.s3Prefix = editMount.realPath || '/';
			// SFTP
			this.sftpHost = editMount.sftpHost ?? '';
			this.sftpPort = editMount.sftpPort ?? 22;
			this.sftpUsername = editMount.sftpUsername ?? '';
			this.sftpPrivateKeyPath = editMount.sftpPrivateKeyPath ?? '';
			// Passwords/passphrases never stored — leave blank
			// Advanced watcher
			this.watcherDebounceMs = editMount.watcherDebounceMs;
			this.watcherUsePolling = editMount.watcherUsePolling ?? false;
			this.watcherPollingIntervalMs = editMount.watcherPollingIntervalMs;
			this.visibleFileFilter = editMount.visibleFileFilter ?? 'all';
			this.watcherCreateFilter = editMount.watcherCreateFilter ?? 'all';
			this.watcherSuppressAllEvents = editMount.watcherSuppressAllEvents ?? false;
			this.maxFiles = editMount.maxFiles;
			// Tags — only pre-populate when editing (not on new mount creation)
			this.tags = editMount.tags ? [...editMount.tags] : [];
			// Large file confirmation
			this.enableLargeFileConfirm = editMount.enableLargeFileConfirm ?? false;
			this.largeFileThresholdKB = editMount.largeFileThresholdKB;
			// Explorer highlight color
			this.highlightColor = editMount.highlightColor ?? '';
		} else if (initialValues) {
			this.mountType = initialValues.mountType ?? this.mountType;
			this.virtualPath = initialValues.virtualPath ?? this.virtualPath;
			this.realPath = initialValues.realPath ?? this.realPath;
			this.readOnly = initialValues.readOnly ?? this.readOnly;
			this.label = initialValues.label ?? this.label;
		}
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		const ownCloud = 'ownCloud';
		const backblazeB2 = 'Backblaze B2';
		const minio = 'MinIO';
		const cloudflareR2 = 'Cloudflare R2';
		const synologyLabel = 'Synology NAS (DSM WebDAV)';
		const qnapLabel = 'QNAP NAS';
		const webdav = 'WebDAV';
		const s3 = 'S3';
		const obsidianDesktop = 'Obsidian Desktop';
		const wslLabel = 'WSL';
		const nas = 'NAS';
		contentEl.createEl('h2', { text: this.editMount ? i18n.t('mountManager.editTitle') : i18n.t('mountManager.title') });

		const isMobile = Platform.isMobile;
		const platform = getPlatform();
		const wsl = isWSL();

		// On mobile, only WebDAV mounts are supported (no local fs access).
		if (isMobile && this.mountType !== 'webdav') {
			this.mountType = 'webdav';
		}

		// ── Mount type selector ─────────────────────────────────────────────
		const localSection = contentEl.createDiv();
		const vaultSection = contentEl.createDiv();
		const webdavSection = contentEl.createDiv();
		const s3Section = contentEl.createDiv();
		const sftpSection = contentEl.createDiv();

		const toggleSections = (type: MountType) => {
			this.mountType = type;
			localSection.toggleClass('folderbridge-hidden', type !== 'local');
			vaultSection.toggleClass('folderbridge-hidden', type !== 'vault');
			webdavSection.toggleClass('folderbridge-hidden', type !== 'webdav');
			s3Section.toggleClass('folderbridge-hidden', type !== 's3');
			sftpSection.toggleClass('folderbridge-hidden', type !== 'sftp');
		};

		if (isMobile) {
			// On mobile, only WebDAV and S3 mounts are supported
			contentEl.createEl('p', {
				text: i18n.t('mountManager.mobileOnly', { webdav, s3, desktop: obsidianDesktop }),
				cls: 'setting-item-description',
			});
			contentEl.createEl('p', {
				text: i18n.t('mountManager.webdavNote'),
				cls: 'setting-item-description',
			});
			new Setting(contentEl)
				.setName(i18n.t('mountManager.mountTypeName'))
				.addDropdown(drop => drop
					.addOption('webdav', `${webdav} (Nextcloud, ${ownCloud}, generic)`)
					.addOption('s3', `Amazon S3 / ${backblazeB2}`)
					.setValue(this.mountType === 's3' ? 's3' : 'webdav')
					.onChange(val => toggleSections(val as MountType)));
			toggleSections(this.mountType === 's3' ? 's3' : 'webdav');
		} else {
			new Setting(contentEl)
				.setName(i18n.t('mountManager.mountTypeName'))
				.setDesc(i18n.t('mountType.desc'))
				.addDropdown(drop => drop
					.addOption('local', i18n.t('mountType.local'))
					.addOption('vault', i18n.t('mountType.vault'))
					.addOption('webdav', `${webdav} (Nextcloud, generic)`)
					.addOption('s3', `Amazon S3 / ${backblazeB2}`)
					.addOption('sftp', i18n.t('mountType.sftp'))
					.setValue(this.mountType)
					.onChange(val => toggleSections(val as MountType)));
			toggleSections(this.mountType);
		} // end else (desktop only)

		// ── Vault section (shown when type === 'vault') ────────────────────
		vaultSection.createEl('p', {
			text: i18n.t('vault.mountedDesc'),
			cls: 'setting-item-description',
		});
		vaultSection.addClass('folderbridge-vault-section');

		let vaultPathText: TextComponent | null = null;
		new Setting(vaultSection)
			.setName(i18n.t('vault.otherVault.name'))
			.setDesc(i18n.t('vault.otherVault.desc'))
			.addText(text => {
				vaultPathText = text;
				text.inputEl.addClass('folderbridge-input-flex');
				text.setPlaceholder(platform === 'windows' ? 'C:\\Users\\YourName\\MyOtherVault' : '/home/yourname/MyOtherVault')
					.setValue(this.mountType === 'vault' ? this.realPath : '')
					.onChange(val => {
						this.realPath = val.trim();
						this.syncAutoLabel();
					});
			})
			.addButton(btn => {
				btn.setButtonText(i18n.t('mountManager.browse'))
					.setTooltip(i18n.t('mountManager.browseTooltip'))
					.onClick(() => {
						void (async () => {
							const selected = await browseFolderOnDisk(i18n.t('mountManager.selectOtherVaultRoot'));
							if (selected) {
								this.realPath = selected;
								vaultPathText?.setValue(selected);
								this.syncAutoLabel();
							}
						})();
					});
			});

		// ── WebDAV fields (shown when type === 'webdav') ───────────────────

		/* Quick-fill presets — selecting one pre-populates Server URL so users
		 * don't have to remember the /remote.php/dav/files/USERNAME/ pattern. */
		const WEBDAV_PRESETS: Record<string, { urlTemplate: string; noteKey: string }> = {
			nextcloud: { urlTemplate: 'https://cloud.example.com/remote.php/dav/files/YOUR_USERNAME', noteKey: 'preset.nextcloud.note' },
			owncloud: { urlTemplate: 'https://cloud.example.com/remote.php/dav/files/YOUR_USERNAME', noteKey: 'preset.owncloud.note' },
			synology: { urlTemplate: 'https://nas.example.com/webdav', noteKey: 'preset.synology.note' },
			qnap: { urlTemplate: 'https://nas.example.com:8080/webdav', noteKey: 'preset.qnap.note' },
		};

		let presetNoteEl: HTMLParagraphElement | null = null;
		let webdavUrlText: import('obsidian').TextComponent | null = null;

		if (!this.editMount) {
			new Setting(webdavSection)
				.setName(i18n.t('preset.quickFill'))
				.setDesc(i18n.t('preset.desc'))
				.addDropdown(drop => {
					drop.addOption('', i18n.t('mountManager.preset.select'));
					drop.addOption('nextcloud', 'Nextcloud');
					drop.addOption('owncloud', `${ownCloud}`);
					drop.addOption('synology', `${synologyLabel}`);
					drop.addOption('qnap', `${qnapLabel}`);
					drop.setValue('');
					drop.onChange(val => {
						const preset = WEBDAV_PRESETS[val];
						if (!preset) return;
						if (webdavUrlText) {
							webdavUrlText.setValue(preset.urlTemplate);
							this.webdavUrl = preset.urlTemplate;
						}
						if (!presetNoteEl) {
							presetNoteEl = webdavSection.createEl('p', { cls: 'folderbridge-preset-note' });
						}
						presetNoteEl.setText('💡 ' + i18n.t(preset.noteKey));
					});
				});
		}

		new Setting(webdavSection)
			.setName(i18n.t('webdav.serverUrl.name'))
			.setDesc(i18n.t('webdav.serverUrl.desc'))
			.addText(text => {
				webdavUrlText = text;
				text.inputEl.addClass('folderbridge-input-flex');
				text.setPlaceholder(i18n.t('webdav.serverUrl.placeholder'))
					.setValue(this.webdavUrl)
					.onChange(val => { this.webdavUrl = val.trim(); });
			});

		new Setting(webdavSection)
			.setName(i18n.t('webdav.remotePath.name'))
			.setDesc(i18n.t('webdav.remotePath.desc'))
			.addText(text => {
				text.inputEl.addClass('folderbridge-input-flex');
				text.setPlaceholder(i18n.t('webdav.remotePath.placeholder'))
					.setValue(this.mountType === 'webdav' ? (this.realPath || '/') : '/')
					.onChange(val => { this.realPath = val.trim() || '/'; });
			});

		new Setting(webdavSection)
			.setName(i18n.t('webdav.username.name'))
			.addText(text => {
				text.inputEl.addClass('folderbridge-input-flex');
				text.setPlaceholder(i18n.t('webdav.username.placeholder'))
					.setValue(this.webdavUsername)
					.onChange(val => { this.webdavUsername = val.trim(); });
			});

		new Setting(webdavSection)
			.setName(i18n.t('webdav.password.name'))
			.setDesc(this.editMount?.mountType === 'webdav'
				? (this.editMount.encryptedWebdavPassword
					? i18n.t('webdav.password.saved')
					: i18n.t('webdav.password.unchanged'))
				: i18n.t('webdav.password.encrypted'))
			.addText(text => {
				text.inputEl.type = 'password';
				text.inputEl.addClass('folderbridge-input-flex');
				const hasStored = !!(this.editMount?.encryptedWebdavPassword);
				text.setPlaceholder(hasStored ? i18n.t('webdav.password.savedPlaceholder') : this.editMount?.mountType === 'webdav' ? i18n.t('webdav.password.unchangedPlaceholder') : i18n.t('webdav.password.placeholder'))
					.setValue('')
					.onChange(val => { this.webdavPassword = val; });
			});

		// ── S3 / Backblaze B2 section ──────────────────────────────────────
		s3Section.createEl('p', {
			text: i18n.t('mountManager.s3Note'),
			cls: 'setting-item-description',
		});

		const S3_PRESETS: Record<string, { region: string; endpoint: string; forcePathStyle: boolean; noteKey: string }> = {
			aws: { region: 'us-east-1', endpoint: '', forcePathStyle: false, noteKey: 'preset.aws.note' },
			b2: { region: 'us-west-004', endpoint: 'https://s3.us-west-004.backblazeb2.com', forcePathStyle: true, noteKey: 'preset.b2.note' },
			minio: { region: 'us-east-1', endpoint: 'http://localhost:9000', forcePathStyle: true, noteKey: 'preset.minio.note' },
			cloudflare: { region: 'auto', endpoint: 'https://<ACCOUNT_ID>.r2.cloudflarestorage.com', forcePathStyle: false, noteKey: 'preset.cloudflare.note' },
		};

		let s3PresetNoteEl: HTMLParagraphElement | null = null;
		let s3RegionText: import('obsidian').TextComponent | null = null;
		let s3EndpointText: import('obsidian').TextComponent | null = null;
		let s3PathStyleToggle: import('obsidian').ToggleComponent | null = null;

		if (!this.editMount) {
			new Setting(s3Section)
				.setName(i18n.t('preset.quickFill'))
				.setDesc(i18n.t('preset.s3Desc'))
				.addDropdown(drop => {
					drop.addOption('', i18n.t('mountManager.preset.select'));
					drop.addOption('aws', 'Amazon S3');
					drop.addOption('b2', `${backblazeB2}`);
					drop.addOption('minio', `${minio} (self-hosted)`);
					drop.addOption('cloudflare', `${cloudflareR2}`);
					drop.setValue('');
					drop.onChange(val => {
						const preset = S3_PRESETS[val];
						if (!preset) return;
						this.s3Region = preset.region;
						this.s3Endpoint = preset.endpoint;
						this.s3ForcePathStyle = preset.forcePathStyle;
						s3RegionText?.setValue(preset.region);
						s3EndpointText?.setValue(preset.endpoint);
						s3PathStyleToggle?.setValue(preset.forcePathStyle);
						if (!s3PresetNoteEl) {
							s3PresetNoteEl = s3Section.createEl('p', { cls: 'folderbridge-preset-note' });
						}
						s3PresetNoteEl.setText(i18n.t(preset.noteKey));
					});
				});
		}

		new Setting(s3Section)
			.setName(i18n.t('s3.bucket.name'))
			.setDesc(i18n.t('s3.bucket.desc'))
			.addText(text => {
				text.inputEl.addClass('folderbridge-input-flex');
				text.setPlaceholder(i18n.t('s3.bucket.placeholder'))
					.setValue(this.s3Bucket)
					.onChange(val => { this.s3Bucket = val.trim(); });
			});

		new Setting(s3Section)
			.setName(i18n.t('s3.region.name'))
			.setDesc(i18n.t('s3.region.desc'))
			.addText(text => {
				s3RegionText = text;
				text.inputEl.addClass('folderbridge-input-flex');
				text.setPlaceholder(i18n.t('s3.region.placeholder'))
					.setValue(this.s3Region)
					.onChange(val => { this.s3Region = val.trim(); });
			});

		new Setting(s3Section)
			.setName(i18n.t('s3.endpoint.name'))
			.setDesc(i18n.t('s3.endpoint.desc'))
			.addText(text => {
				s3EndpointText = text;
				text.inputEl.addClass('folderbridge-input-flex');
				text.setPlaceholder(i18n.t('s3.endpoint.placeholder'))
					.setValue(this.s3Endpoint)
					.onChange(val => { this.s3Endpoint = val.trim(); });
			});

		new Setting(s3Section)
			.setName(i18n.t('s3.keyPrefix.name'))
			.setDesc(i18n.t('s3.keyPrefix.desc'))
			.addText(text => {
				text.inputEl.addClass('folderbridge-input-flex');
				text.setPlaceholder('/')
					.setValue(this.s3Prefix)
					.onChange(val => { this.s3Prefix = val.trim() || '/'; });
			});

		new Setting(s3Section)
			.setName(i18n.t('s3.accessKeyId.name'))
			.setDesc(i18n.t('s3.accessKeyId.desc'))
			.addText(text => {
				text.inputEl.addClass('folderbridge-input-flex');
				text.setPlaceholder(i18n.t('s3.accessKeyId.placeholder'))
					.setValue(this.s3AccessKeyId)
					.onChange(val => { this.s3AccessKeyId = val.trim(); });
			});

		new Setting(s3Section)
			.setName(i18n.t('s3.secretKey.name'))
			.setDesc(this.editMount?.mountType === 's3'
				? (this.editMount.encryptedS3SecretKey
					? i18n.t('s3.secretKey.saved')
					: i18n.t('s3.secretKey.unchanged'))
				: i18n.t('s3.secretKey.encrypted'))
			.addText(text => {
				text.inputEl.type = 'password';
				text.inputEl.addClass('folderbridge-input-flex');
				const hasStored = !!(this.editMount?.encryptedS3SecretKey);
				text.setPlaceholder(hasStored ? i18n.t('s3.secretKey.savedPlaceholder') : i18n.t('s3.secretKey.placeholder'))
					.setValue('')
					.onChange(val => { this.s3SecretKey = val; });
			});

		new Setting(s3Section)
			.setName(i18n.t('s3.forcePathStyle.name'))
			.setDesc(i18n.t('s3.forcePathStyle.desc'))
			.addToggle(toggle => {
				s3PathStyleToggle = toggle;
				toggle.setValue(this.s3ForcePathStyle)
					.onChange(val => { this.s3ForcePathStyle = val; });
			});

		// ── SFTP section ────────────────────────────────────────────────
		sftpSection.createEl('p', {
			text: i18n.t('mountManager.sftpNote'),
			cls: 'setting-item-description',
		});

		new Setting(sftpSection)
			.setName(i18n.t('sftp.host.name'))
			.setDesc(i18n.t('sftp.host.desc'))
			.addText(text => {
				text.inputEl.addClass('folderbridge-input-flex');
				text.setPlaceholder(i18n.t('sftp.host.placeholder'))
					.setValue(this.sftpHost)
					.onChange(val => { this.sftpHost = val.trim(); });
			});

		new Setting(sftpSection)
			.setName(i18n.t('sftp.port.name'))
			.setDesc(i18n.t('sftp.port.desc'))
			.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.addClass('folderbridge-input-narrow');
				text.setPlaceholder(i18n.t('sftp.port.placeholder'))
					.setValue(String(this.sftpPort))
					.onChange(val => {
						const n = parseInt(val, 10);
						this.sftpPort = isNaN(n) || n <= 0 ? 22 : n;
					});
			});

		new Setting(sftpSection)
			.setName(i18n.t('sftp.username.name'))
			.addText(text => {
				text.inputEl.addClass('folderbridge-input-flex');
				text.setPlaceholder(i18n.t('sftp.username.placeholder'))
					.setValue(this.sftpUsername)
					.onChange(val => { this.sftpUsername = val.trim(); });
			});

		new Setting(sftpSection)
			.setName(i18n.t('sftp.remotePath.name'))
			.setDesc(i18n.t('sftp.remotePath.desc'))
			.addText(text => {
				text.inputEl.addClass('folderbridge-input-flex');
				text.setPlaceholder(i18n.t('sftp.remotePath.placeholder'))
					.setValue(this.mountType === 'sftp' ? (this.realPath || '/home') : '/home')
					.onChange(val => { this.realPath = val.trim() || '/'; });
			});

		new Setting(sftpSection)
			.setName(i18n.t('sftp.password.name'))
			.setDesc(this.editMount?.mountType === 'sftp'
				? (this.editMount.encryptedSftpPassword
					? i18n.t('sftp.password.saved')
					: i18n.t('sftp.password.unchanged'))
				: i18n.t('sftp.password.newDesc'))
			.addText(text => {
				text.inputEl.type = 'password';
				text.inputEl.addClass('folderbridge-input-flex');
				const hasStored = !!(this.editMount?.encryptedSftpPassword);
				text.setPlaceholder(hasStored ? i18n.t('sftp.password.savedPlaceholder') : i18n.t('sftp.password.placeholder'))
					.setValue('')
					.onChange(val => { this.sftpPassword = val; });
			});

		new Setting(sftpSection)
			.setName(i18n.t('sftp.privateKey.name'))
			.setDesc(i18n.t('sftp.privateKey.desc'))
			.addText(text => {
				text.inputEl.addClass('folderbridge-input-flex');
				text.setPlaceholder(i18n.t('sftp.privateKey.placeholder'))
					.setValue(this.sftpPrivateKeyPath)
					.onChange(val => { this.sftpPrivateKeyPath = val.trim(); });
			});

		new Setting(sftpSection)
			.setName(i18n.t('sftp.passphrase.name'))
			.setDesc(this.editMount?.mountType === 'sftp'
				? (this.editMount.encryptedSftpPassphrase
					? i18n.t('sftp.passphrase.savedDesc')
					: i18n.t('sftp.passphrase.unchangedDesc'))
				: i18n.t('sftp.passphrase.neededDesc'))
			.addText(text => {
				text.inputEl.type = 'password';
				text.inputEl.addClass('folderbridge-input-flex');
				const hasStored = !!(this.editMount?.encryptedSftpPassphrase);
				text.setPlaceholder(hasStored ? i18n.t('sftp.passphrase.savedPlaceholder') : i18n.t('sftp.passphrase.placeholder'))
					.setValue('')
					.onChange(val => { this.sftpPassphrase = val; });
			});

		// Apply initial visibility
		toggleSections(this.mountType);

		// Choose a platform-appropriate placeholder for the real path
		let realPlaceholder: string;
		if (platform === 'windows') {
			realPlaceholder = 'C:\\Users\\YourName\\Documents\\Work';
		} else if (wsl) {
			realPlaceholder = '/home/yourname/docs   or   /mnt/c/Users/YourName/docs';
		} else {
			realPlaceholder = '/home/yourname/Documents/Work';
		}

		// ── Real path ──────────────────────────────────────────────────────
		const realPathSetting = new Setting(localSection)
			.setName(i18n.t('vault.realPath.name'))
			.setDesc(i18n.t('vault.realPath.desc'))
			.addText(text => {
				this.realPathText = text;
				text.inputEl.addClass('folderbridge-input-flex');
				text.setPlaceholder(realPlaceholder)
					.setValue(this.realPath)
					.onChange(val => {
						this.realPath = val.trim();
						this.syncAutoLabel();
					});
			})
			.addButton(btn => {
				btn.setButtonText(i18n.t('mountManager.browse'))
					.setTooltip(i18n.t('mountManager.browseTooltip'))
					.onClick(() => {
						void (async () => {
							const selected = await browseFolderOnDisk(i18n.t('mountManager.selectExternalFolder'));
							if (selected) {
								this.realPath = selected;
								this.realPathText?.setValue(selected);
								this.syncAutoLabel();
							}
						})();
					});
				btn.buttonEl.setAttribute('aria-label', i18n.t('mountManager.browseAriaLabel'));
			});

		if (platform === 'windows') {
			realPathSetting.addButton(btn => {
				btn.setButtonText(i18n.t('mountState.wslBrowse'))
					.setTooltip(i18n.t('mountState.wslBrowse.tooltip'))
					.onClick(() => {
						void (async () => {
							const selected = await browseFolderOnDisk(i18n.t('mountManager.selectWslFolder'), '\\\\wsl.localhost');
							if (selected) {
								this.realPath = selected;
								this.realPathText?.setValue(selected);
								this.syncAutoLabel();
							}
						})();
					});
				btn.buttonEl.setAttribute('aria-label', i18n.t('mountManager.browseForLabel', { label: wslLabel }));
			});
		}

		// WSL context hints
		if (platform === 'windows') {
			localSection.createEl('p', {
				text: i18n.t('mountManager.wslTip1') + ' ' +
					i18n.t('mountManager.wslPath1') + ' ' +
					i18n.t('mountManager.wslTipOr') + ' ' +
					i18n.t('mountManager.wslPath2') + '. ' +
					i18n.t('mountManager.wslTipAddressBar'),
				cls: 'setting-item-description',
			});
		} else if (wsl) {
			localSection.createEl('p', {
				text: i18n.t('mountManager.wslTip2') + ' ' +
					i18n.t('mountManager.wslPath1') + ' ' +
					i18n.t('mountManager.wslTipOr') + ' ' +
					i18n.t('mountManager.wslPath2') + '.',
				cls: 'setting-item-description',
			});
		}

		let fallbackPathText: import('obsidian').TextComponent | null = null;
		new Setting(localSection)
			.setName(i18n.t('vault.fallbackPath.name'))
			.setDesc(i18n.t('vault.fallbackPath.desc'))
			.addText(text => {
				fallbackPathText = text;
				text.inputEl.addClass('folderbridge-input-flex');
				text.inputEl.addClass('folderbridge-input-min-200');
				text.setPlaceholder(i18n.t('vault.fallbackPath.placeholder'))
					.setValue(this.fallbackRealPath)
					.onChange(val => { this.fallbackRealPath = val.trim(); });
			})
			.addButton(btn => {
				btn.setButtonText(i18n.t('mountManager.browse'))
					.setTooltip(i18n.t('mountManager.browseTooltip'))
					.onClick(() => {
						void (async () => {
							const selected = await browseFolderOnDisk(i18n.t('mountManager.selectFallbackFolder'));
							if (selected) {
								this.fallbackRealPath = selected;
								fallbackPathText?.setValue(selected);
							}
						})();
					});
				btn.buttonEl.setAttribute('aria-label', i18n.t('mountManager.browseFallbackAriaLabel'));
			});

		// ── Virtual path ───────────────────────────────────────────────────
		new Setting(contentEl)
			.setClass('folderbridge-path-setting')
			.setName(i18n.t('mountManager.virtualPath.name'))
			.setDesc(i18n.t('mountManager.virtualPath.desc'))
			.addText(text => {
				this.virtualPathText = text;
				text.inputEl.addClass('folderbridge-input-flex');
				text.setPlaceholder(i18n.t('mountManager.virtualPath.placeholder'))
					.setValue(this.virtualPath)
					.onChange(val => { this.virtualPath = val.trim(); });
			})
			.addButton(btn => {
				btn.setButtonText(i18n.t('mountManager.browseVault'))
					.setTooltip(i18n.t('mountManager.browseVaultTooltip'))
					.onClick(() => {
						new VaultFolderPickerModal(this.app, (chosen) => {
							// `chosen` is '' for vault root, or an existing folder path.
							// Preserve any leaf name the user already typed; if empty,
							// default to the real folder's base name.
							const trimmedVirtualPath = this.virtualPath.trim();
							const existingLeaf = trimmedVirtualPath
								? path.posix.basename(trimmedVirtualPath)
								: '';
							const leaf = existingLeaf || (this.realPath ? path.basename(this.realPath) : '');
							const combined = chosen
								? normalizePath(`${chosen}/${leaf}`)
								: leaf;
							this.virtualPath = combined;
							this.virtualPathText?.setValue(combined);
						}).open();
					});
				btn.buttonEl.setAttribute('aria-label', i18n.t('mountManager.browseVaultFolders'));
			});

		// ── Use folder name as label ───────────────────────────────────────
		new Setting(contentEl)
			.setName(i18n.t('mountManager.useFolderNameAsLabel'))
			.setDesc(i18n.t('mountManager.useFolderNameAsLabel.desc'))
			.addToggle(toggle => toggle
				.setValue(this.useFolderNameAsLabel)
				.onChange(val => {
					this.useFolderNameAsLabel = val;
					// Only auto-fill when enabling the toggle and the label is currently empty
					if (val) {
						const currentLabel =
							(this.labelText?.getValue?.() ?? this.label ?? '').trim();
						if (!currentLabel) {
							this.syncAutoLabel();
						}
					}
				}));

		// ── Label ──────────────────────────────────────────────────────────
		new Setting(contentEl)
			.setName(i18n.t('mountManager.label.name'))
			.setDesc(i18n.t('mountManager.label.desc'))
			.addText(text => {
				this.labelText = text;
				text.setPlaceholder(i18n.t('mountManager.label.placeholder'))
					.setValue(this.label)
					.onChange(val => {
						this.label = val.trim();
						// Update default tags for new mounts when label changes
						if (!this.editMount) {
							this.tags = this.getDefaultTags();
							tagsText?.setValue(this.tags.join(', '));
						}
					});
			});

		// ── Read-only ──────────────────────────────────────────────────────
		new Setting(contentEl)
			.setName(i18n.t('mountManager.readOnly'))
			.setDesc(`When enabled, ${this.pluginName} will refuse any write operations to this mount`)
			.addToggle(toggle => toggle
				.setValue(this.readOnly)
				.onChange(val => { this.readOnly = val; }));

		// ── Additional settings (collapsible) ──────────────────────────────
		const additionalDetails = contentEl.createEl('details', { cls: 'folderbridge-additional' });
		additionalDetails.createEl('summary', { text: i18n.t('mountManager.additionalSettings') });

		const additionalContainer = additionalDetails.createDiv();

		// ── Tags ───────────────────────────────────────────────────────────
		let tagsText: TextComponent | null = null;
		new Setting(additionalContainer)
			.setName(i18n.t('mountManager.tags.name'))
			.setDesc(i18n.t('mountManager.tags.desc'))
			.addText(text => {
				tagsText = text;
				text.inputEl.addClass('folderbridge-input-flex');
				text.setPlaceholder(i18n.t('mountManager.tags.placeholder'))
					.setValue(this.tags.join(', '))
					.onChange(val => { this.tags = this.parseTags(val); });
			});

		// ── Priority ───────────────────────────────────────────────────────
		new Setting(additionalContainer)
			.setName(i18n.t('mountManager.priority.name'))
			.setDesc(i18n.t('mountManager.priority.desc'))
			.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = '0';
				text.inputEl.addClass('folderbridge-input-narrow');
				text.setPlaceholder(i18n.t('mountManager.priority.placeholder'))
					.setValue(String(this.priority))
					.onChange(val => {
						const n = parseInt(val, 10);
						this.priority = isNaN(n) || n < 0 ? 100 : n;
					});
			});

		// ── Add command to palette ─────────────────────────────────────────
		new Setting(additionalContainer)
			.setName(i18n.t('mountManager.addCommand.name'))
			.setDesc(i18n.t('mountManager.addCommand.desc'))
			.addToggle(toggle => toggle
				.setValue(this.addCommand)
				.onChange(val => { this.addCommand = val; }));

		// ── Large file transfer warning ────────────────────────────────────
		new Setting(additionalContainer)
			.setName(i18n.t('mountManager.largeFileWarning.name'))
			.setDesc(i18n.t('mountManager.largeFileWarning.desc'))
			.addToggle(toggle => toggle
				.setValue(this.enableLargeFileConfirm)
				.onChange(val => { this.enableLargeFileConfirm = val; }));

		new Setting(additionalContainer)
			.setName(i18n.t('mountManager.largeFileWarning.threshold.name'))
			.setDesc(i18n.t('mountManager.largeFileWarning.threshold.desc'))
			.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = '1';
				text.inputEl.addClass('folderbridge-input-narrow');
				text.setPlaceholder(i18n.t('mountManager.largeFileWarning.threshold.placeholder'))
					.setValue(this.largeFileThresholdKB != null ? String(this.largeFileThresholdKB) : '')
					.onChange(val => {
						const n = parseInt(val, 10);
						this.largeFileThresholdKB = isNaN(n) || n <= 0 ? undefined : n;
					});
			});

		// ── Explorer highlight color ─────────────────────────────────────
		const highlightColors = [
			{ value: '', label: i18n.t('mountManager.highlightColor.none'), color: '' },
			{ value: '#4a90d9', label: i18n.t('mountManager.highlightColor.blue'), color: '#4a90d9' },
			{ value: '#e67e22', label: i18n.t('mountManager.highlightColor.orange'), color: '#e67e22' },
			{ value: '#27ae60', label: i18n.t('mountManager.highlightColor.green'), color: '#27ae60' },
			{ value: '#e74c3c', label: i18n.t('mountManager.highlightColor.red'), color: '#e74c3c' },
			{ value: '#9b59b6', label: i18n.t('mountManager.highlightColor.purple'), color: '#9b59b6' },
			{ value: '#1abc9c', label: i18n.t('mountManager.highlightColor.teal'), color: '#1abc9c' },
			{ value: '#f39c12', label: i18n.t('mountManager.highlightColor.yellow'), color: '#f39c12' },
		];

		// Track current state
		let currentColor = this.highlightColor; // The actual value stored ('' or hex)
		
		// Determine initial preset selection based on current color
		let currentPresetValue: string;
		if (!currentColor) {
			currentPresetValue = ''; // None
		} else {
			const presetIdx = findPresetIndex(currentColor);
			currentPresetValue = presetIdx >= 0 ? highlightColors[presetIdx].value : '__custom__';
		}

		// Helper: find preset index by color value
		function findPresetIndex(color: string): number {
			if (!color) return 0; // None
			const idx = highlightColors.findIndex(hc => hc.value && hc.color === color.toLowerCase());
			return idx >= 0 ? idx : -1;
		}

		// Helper: normalize color for comparison (lowercase, trim)
		function normalizeColor(color: string): string {
			return color.trim().toLowerCase();
		}

		// Custom dropdown with colored swatches (option elements don't support background-color in any browser)
		const dropdownWrapper = document.createElement('div');
		dropdownWrapper.style.position = 'relative';
		dropdownWrapper.style.display = 'inline-block';
		dropdownWrapper.style.width = '100%';

		const dropdownTrigger = document.createElement('div');
		dropdownTrigger.className = 'mod-dropdown';
		dropdownTrigger.style.cursor = 'pointer';
		dropdownTrigger.style.padding = '8px';
		dropdownTrigger.style.border = '1px solid var(--background-modifier-border)';
		dropdownTrigger.style.borderRadius = '4px';
		dropdownTrigger.style.backgroundColor = 'var(--background-primary)';
		dropdownTrigger.style.color = 'var(--text-normal)';
		dropdownTrigger.style.userSelect = 'none';

		const dropdownMenu = document.createElement('div');
		dropdownMenu.style.display = 'none';
		dropdownMenu.style.position = 'absolute';
		dropdownMenu.style.top = '100%';
		dropdownMenu.style.left = '0';
		dropdownMenu.style.right = '0';
		dropdownMenu.style.backgroundColor = 'var(--background-primary)';
		dropdownMenu.style.border = '1px solid var(--background-modifier-border)';
		dropdownMenu.style.borderRadius = '4px';
		dropdownMenu.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
		dropdownMenu.style.zIndex = '1000';
		dropdownMenu.style.maxHeight = '280px';
		dropdownMenu.style.overflowY = 'auto';

		// Add "Custom" option at the end
		const customOption = { value: '__custom__', label: 'Custom...', color: '' };
		const allOptions = [...highlightColors, customOption];

		for (const opt of allOptions) {
			const menuOption = document.createElement('div');
			menuOption.style.display = 'flex';
			menuOption.style.alignItems = 'center';
			menuOption.style.gap = '8px';
			menuOption.style.padding = '8px 12px';
			menuOption.style.cursor = 'pointer';
			menuOption.style.color = 'var(--text-normal)';
			menuOption.style.fontSize = 'var(--font-ui-small)';

			// Color swatch (skip for Custom option)
			if (opt.value !== '__custom__') {
				const swatch = document.createElement('span');
				swatch.style.width = '16px';
				swatch.style.height = '16px';
				swatch.style.borderRadius = '3px';
				swatch.style.border = opt.color ? 'none' : '1px solid var(--text-muted)';
				if (opt.color) {
					swatch.style.backgroundColor = opt.color;
				} else {
					swatch.style.backgroundColor = 'var(--background-primary)';
				}
				menuOption.appendChild(swatch);
			} else {
				// Placeholder for alignment
				const spacer = document.createElement('span');
				spacer.style.width = '16px';
				spacer.style.height = '16px';
				menuOption.appendChild(spacer);
			}

			// Label
			const labelSpan = document.createElement('span');
			labelSpan.textContent = opt.label;
			menuOption.appendChild(labelSpan);

			menuOption.addEventListener('mouseenter', () => {
				menuOption.style.backgroundColor = 'var(--background-modifier-hover)';
			});
			menuOption.addEventListener('mouseleave', () => {
				menuOption.style.backgroundColor = '';
			});
			menuOption.addEventListener('click', () => {
				if (opt.value === '__custom__') {
					// Focus the color picker when Custom is selected
					colorInput.focus();
					return;
				}
				currentColor = opt.value;
				currentPresetValue = opt.value;
				this.highlightColor = opt.value;
				updateColorPicker();
				updateTrigger();
				dropdownMenu.style.display = 'none';
			});

			dropdownMenu.appendChild(menuOption);
		}

		// Update dropdown trigger display
		function updateTrigger(): void {
			const selected = allOptions.find(opt => opt.value === currentPresetValue) || allOptions[0];
			dropdownTrigger.innerHTML = '';
			if (selected.value !== '__custom__') {
				const swatch = document.createElement('span');
				swatch.style.width = '16px';
				swatch.style.height = '16px';
				swatch.style.borderRadius = '3px';
				swatch.style.border = selected.color ? 'none' : '1px solid var(--text-muted)';
				if (selected.color) {
					swatch.style.backgroundColor = selected.color;
				} else {
					swatch.style.backgroundColor = 'var(--background-primary)';
				}
				swatch.style.marginRight = '8px';
				dropdownTrigger.appendChild(swatch);
			}
			const labelSpan = document.createElement('span');
			labelSpan.textContent = selected.label;
			dropdownTrigger.appendChild(labelSpan);
		}

		// Color picker input
		const colorPickerContainer = document.createElement('div');
		colorPickerContainer.style.display = 'flex';
		colorPickerContainer.style.alignItems = 'center';
		colorPickerContainer.style.marginLeft = '8px';

		const colorInput = document.createElement('input');
		colorInput.type = 'color';
		colorInput.style.width = '32px';
		colorInput.style.height = '32px';
		colorInput.style.border = '1px solid var(--background-modifier-border)';
		colorInput.style.borderRadius = '4px';
		colorInput.style.padding = '2px';
		colorInput.style.cursor = 'pointer';
		colorInput.style.backgroundColor = 'var(--background-primary)';

		function updateColorPicker(): void {
			if (!currentColor) {
				// "None" — use a neutral/default color
				colorInput.value = '#808080';
			} else {
				colorInput.value = currentColor.toLowerCase();
			}
		}

		colorInput.addEventListener('input', (e) => {
			const selectedColor = (e.target as HTMLInputElement).value;
			currentColor = selectedColor;
			this.highlightColor = selectedColor;

			// Check if this color matches a preset
			const presetIdx = findPresetIndex(selectedColor);
			if (presetIdx >= 0) {
				currentPresetValue = highlightColors[presetIdx].value;
			} else {
				currentPresetValue = '__custom__';
			}

			updateTrigger();
		});

		colorPickerContainer.appendChild(colorInput);

		// Initialize UI state
		updateColorPicker();
		updateTrigger();

		dropdownTrigger.addEventListener('click', (e) => {
			e.stopPropagation();
			const isOpen = dropdownMenu.style.display === 'block';
			dropdownMenu.style.display = isOpen ? 'none' : 'block';
		});

		dropdownWrapper.appendChild(dropdownTrigger);
		dropdownWrapper.appendChild(dropdownMenu);

		// Close dropdown when clicking outside
		this._closeDropdownHandler = (e: MouseEvent) => {
			if (!dropdownWrapper.contains(e.target as Node)) {
				dropdownMenu.style.display = 'none';
			}
		};
		document.addEventListener('click', this._closeDropdownHandler, true);

		// Create setting with both dropdown and color picker
		const setting = new Setting(additionalContainer)
			.setName(i18n.t('mountManager.highlightColor.name'))
			.setDesc(i18n.t('mountManager.highlightColor.desc'));

		const controlContainer = document.createElement('div');
		controlContainer.style.display = 'flex';
		controlContainer.style.alignItems = 'center';
		controlContainer.style.width = '100%';
		controlContainer.appendChild(dropdownWrapper);
		controlContainer.appendChild(colorPickerContainer);

		setting.settingEl.appendChild(controlContainer);

		// ── Advanced settings (collapsible, desktop-only) ──────────────────
		const details = contentEl.createEl('details', { cls: 'folderbridge-advanced' });
		// File-watcher settings are desktop-only; hide the entire Advanced section on mobile.
		if (isMobile) details.addClass('folderbridge-hidden');
		details.createEl('summary', { text: i18n.t('mountManager.advancedSettings') });

		const advancedContainer = details.createDiv();

		// ── Advanced settings (file-watcher + performance) ─────────────────
		new Setting(advancedContainer)
			.setName(i18n.t('watcher.debounce.name'))
			.setDesc(i18n.t('watcher.debounce.desc'))
			.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = '50';
				text.inputEl.max = '5000';
				text.inputEl.addClass('folderbridge-input-narrow');
				text.setPlaceholder(i18n.t('watcher.debounce.placeholder'))
					.setValue(this.watcherDebounceMs != null ? String(this.watcherDebounceMs) : '')
					.onChange(val => {
						const n = parseInt(val, 10);
						this.watcherDebounceMs = isNaN(n) || n <= 0 ? undefined : Math.min(5000, Math.max(50, n));
					});
			});

		let pollingIntervalSetting: Setting | null = null;

		const showHidePollingInterval = (show: boolean) => {
			if (pollingIntervalSetting) {
				pollingIntervalSetting.settingEl.classList.toggle('folderbridge-hidden', !show);
			}
		};

		new Setting(advancedContainer)
			.setName(i18n.t('watcher.polling.name'))
			.setDesc(`Poll for changes instead of native OS events. Required for ${nas} drives and network shares where native filesystem events are unreliable.`)
			.addToggle(toggle => toggle
				.setValue(this.watcherUsePolling)
				.onChange(val => {
					this.watcherUsePolling = val;
					showHidePollingInterval(val);
				}));

		pollingIntervalSetting = new Setting(advancedContainer)
			.setName(i18n.t('watcher.pollingInterval.name'))
			.setDesc(i18n.t('watcher.pollingInterval.desc'))
			.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = '500';
				text.inputEl.max = '60000';
				text.inputEl.addClass('folderbridge-input-narrow');
				text.setPlaceholder(i18n.t('watcher.pollingInterval.placeholder'))
					.setValue(this.watcherPollingIntervalMs != null ? String(this.watcherPollingIntervalMs) : '')
					.onChange(val => {
						const n = parseInt(val, 10);
						this.watcherPollingIntervalMs = isNaN(n) || n <= 0 ? undefined : Math.min(60000, Math.max(500, n));
					});
			});
		showHidePollingInterval(this.watcherUsePolling);

		new Setting(advancedContainer)
			.setName(i18n.t('watcher.visibleFileTypes.name'))
			.setDesc(i18n.t('watcher.visibleFileTypes.desc'))
			.addDropdown(drop => drop
				.addOption('all', i18n.t('watcher.visibleFileTypes.all'))
				.addOption('markdown-only', i18n.t('watcher.visibleFileTypes.markdownOnly'))
				.addOption('pdf-only', i18n.t('watcher.visibleFileTypes.pdfOnly'))
				.setValue(this.visibleFileFilter)
				.onChange((val) => { this.visibleFileFilter = val as 'all' | 'markdown-only' | 'pdf-only'; }));

		new Setting(advancedContainer)
			.setName(i18n.t('watcher.newFileEvents.name'))
			.setDesc(i18n.t('watcher.newFileEvents.desc'))
			.addDropdown(drop => drop
				.addOption('all', i18n.t('watcher.newFileEvents.all'))
				.addOption('markdown-only', i18n.t('watcher.newFileEvents.markdownOnly'))
				.setValue(this.watcherCreateFilter)
				.onChange((val) => { this.watcherCreateFilter = val as 'all' | 'markdown-only'; }));

		new Setting(advancedContainer)
			.setName(i18n.t('watcher.suppressAll.name'))
			.setDesc(i18n.t('watcher.suppressAll.desc'))
			.addToggle(toggle => toggle
				.setValue(this.watcherSuppressAllEvents)
				.onChange(val => { this.watcherSuppressAllEvents = val; }));

		new Setting(advancedContainer)
			.setName(i18n.t('watcher.maxFiles.name'))
			.setDesc(i18n.t('watcher.maxFiles.desc'))
			.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = '0';
				text.inputEl.addClass('folderbridge-input-medium');
				text.setPlaceholder(i18n.t('watcher.maxFiles.placeholder'))
					.setValue(this.maxFiles != null ? String(this.maxFiles) : '')
					.onChange(val => {
						const n = parseInt(val, 10);
						this.maxFiles = isNaN(n) || n <= 0 ? undefined : n;
					});
			});
		// ── Action buttons ─────────────────────────────────────────────────
		new Setting(contentEl)
			.addButton(btn => {
				this.saveButton = btn;
				return btn
					.setButtonText(this.submitState.currentLabel())
					.setCta()
					.onClick(() => {
						void this.handleSave().catch(err => {
							this.submitState.finish();
							this.syncSubmitButtons();
							logger.error('Folder Bridge: Failed to save mount', err);
							new Notice(i18n.t('mountManager.saveFailed'));
						});
					});
			})
			.addButton(btn => {
				this.cancelButton = btn;
				return btn
					.setButtonText(i18n.t('button.cancel'))
					.onClick(() => this.close());
			});

		// Apply default tags for new mounts
		if (!this.editMount) {
			this.tags = this.getDefaultTags();
			// tagsText is guaranteed to be initialized before this point
			(tagsText as import('obsidian').TextComponent | null)?.setValue(this.tags.join(', '));
		}
	}

	// ------------------------------------------------------------------
	// Helpers
	// ------------------------------------------------------------------

	/**
	 * If "use folder name as label" is active, overwrite the label field
	 * with the basename of the current real path.
	 * Also updates default tags for new mounts.
	 */
	private syncAutoLabel(): void {
		if (!this.useFolderNameAsLabel) return;
		const name = this.realPath ? path.basename(this.realPath) : '';
		this.label = name;
		this.labelText?.setValue(name);
		// Update default tags for new mounts
		if (!this.editMount) {
			this.tags = this.getDefaultTags();
		}
	}

	/**
	 * Parse comma-separated tag string into an array of non-empty, trimmed tags.
	 */
	private parseTags(input: string): string[] {
		return input
			.split(',')
			.map(t => t.trim())
			.filter(t => t.length > 0);
	}

	/**
	 * Get default tags for a new mount: "all" and optionally the label value.
	 */
	private getDefaultTags(): string[] {
		const defaults: string[] = ['all'];
		if (this.label && this.label.trim().length > 0) {
			defaults.push(this.label.trim());
		}
		return defaults;
	}

	/**
	 * Set default tags for a new mount based on current label.
	 * Note: UI update is done after tagsText is initialized in onOpen.
	 */
	private applyDefaultTags(): void {
		if (!this.editMount) {
			this.tags = this.getDefaultTags();
		}
	}

	private syncSubmitButtons(): void {
		const isBusy = this.submitState.isBusy();
		this.saveButton?.setDisabled(isBusy);
		this.cancelButton?.setDisabled(isBusy);
		this.saveButton?.setButtonText(this.submitState.currentLabel());
	}

	// ------------------------------------------------------------------
	// Save / validation
	// ------------------------------------------------------------------

	private async handleSave(): Promise<void> {
		if (!this.submitState.tryBegin()) return;
		this.syncSubmitButtons();

		const isWebDAV = this.mountType === 'webdav';
		const isS3 = this.mountType === 's3';
		const isSFTP = this.mountType === 'sftp';

		// ── S3-specific validation ──────────────────────────────────────────
		if (isS3) {
			if (!this.s3Bucket) {
				this.submitState.finish();
				this.syncSubmitButtons();
				new Notice(i18n.t('mountManager.required', { field: i18n.t('s3.bucket.name') }));
				return;
			}
			if (!this.s3Region) {
				this.submitState.finish();
				this.syncSubmitButtons();
				new Notice(i18n.t('mountManager.required', { field: i18n.t('s3.region.name') }));
				return;
			}
			if (!this.s3AccessKeyId) {
				this.submitState.finish();
				this.syncSubmitButtons();
				new Notice(i18n.t('mountManager.required', { field: i18n.t('s3.accessKeyId.name') }));
				return;
			}
			const hasStoredSecret = !!(this.editMount?.encryptedS3SecretKey);
			if (!this.editMount && !this.s3SecretKey && !hasStoredSecret) {
				this.submitState.finish();
				this.syncSubmitButtons();
				new Notice(i18n.t('mountManager.required', { field: i18n.t('s3.secretKey.name') }));
				return;
			}
			if (!this.virtualPath.trim()) {
				this.submitState.finish();
				this.syncSubmitButtons();
				new Notice(i18n.t('mountManager.required', { field: i18n.t('mountManager.virtualPath.name') }));
				return;
			}

			const normalizedVirtual = normalizePath(this.virtualPath.trim());
			const prefix = this.s3Prefix || '/';

			await this.onSave(
				{
					virtualPath: normalizedVirtual,
					realPath: prefix,
					enabled: this.editMount ? this.editMount.enabled : true,
					readOnly: this.readOnly,
					label: this.label || undefined,
					addCommand: this.addCommand || undefined,
					priority: this.priority,
					tags: this.tags.length > 0 ? this.tags : undefined,
					enableLargeFileConfirm: this.enableLargeFileConfirm || undefined,
					largeFileThresholdKB: this.largeFileThresholdKB,
					highlightColor: this.highlightColor || undefined,
					mountType: 's3',
					s3Bucket: this.s3Bucket,
					s3Region: this.s3Region,
					s3Endpoint: this.s3Endpoint || undefined,
					s3AccessKeyId: this.s3AccessKeyId,
					s3ForcePathStyle: this.s3ForcePathStyle || undefined,
					s3SecretKey: this.s3SecretKey || undefined,
					visibleFileFilter: this.visibleFileFilter !== 'all' ? this.visibleFileFilter : undefined,
					maxFiles: this.maxFiles,
				},
				this.editMount?.id,
			);
			this.close();
			return;
		}

		// ── SFTP-specific validation ────────────────────────────────────────
		if (isSFTP) {
			if (!this.sftpHost) {
				this.submitState.finish();
				this.syncSubmitButtons();
				new Notice(i18n.t('mountManager.required', { field: i18n.t('sftp.host.name') }));
				return;
			}
			if (!this.sftpUsername) {
				this.submitState.finish();
				this.syncSubmitButtons();
				new Notice(i18n.t('mountManager.required', { field: i18n.t('sftp.username.name') }));
				return;
			}
			const hasStoredPassword = !!(this.editMount?.encryptedSftpPassword);
			const hasKeyPath = !!this.sftpPrivateKeyPath;
			if (!this.editMount && !this.sftpPassword && !hasStoredPassword && !hasKeyPath) {
				this.submitState.finish();
				this.syncSubmitButtons();
				new Notice(i18n.t('mountManager.required', { field: i18n.t('sftp.password.name') }));
				return;
			}
			if (!this.virtualPath.trim()) {
				this.submitState.finish();
				this.syncSubmitButtons();
				new Notice(i18n.t('mountManager.required', { field: i18n.t('mountManager.virtualPath.name') }));
				return;
			}

			const normalizedVirtual = normalizePath(this.virtualPath.trim());
			const remotePath = this.realPath || '/';

			await this.onSave(
				{
					virtualPath: normalizedVirtual,
					realPath: remotePath,
					enabled: this.editMount ? this.editMount.enabled : true,
					readOnly: this.readOnly,
					label: this.label || undefined,
					addCommand: this.addCommand || undefined,
					priority: this.priority,
					tags: this.tags.length > 0 ? this.tags : undefined,
					enableLargeFileConfirm: this.enableLargeFileConfirm || undefined,
					largeFileThresholdKB: this.largeFileThresholdKB,
					highlightColor: this.highlightColor || undefined,
					mountType: 'sftp',
					sftpHost: this.sftpHost,
					sftpPort: this.sftpPort !== 22 ? this.sftpPort : undefined,
					sftpUsername: this.sftpUsername,
					sftpPassword: this.sftpPassword || undefined,
					sftpPrivateKeyPath: this.sftpPrivateKeyPath || undefined,
					sftpPassphrase: this.sftpPassphrase || undefined,
					visibleFileFilter: this.visibleFileFilter !== 'all' ? this.visibleFileFilter : undefined,
					maxFiles: this.maxFiles,
				},
				this.editMount?.id,
			);
			this.close();
			return;
		}

		// ── WebDAV-specific validation ─────────────────────────────────────
		if (isWebDAV) {
			if (!this.webdavUrl) {
				this.submitState.finish();
				this.syncSubmitButtons();
				new Notice(i18n.t('mountManager.required', { field: i18n.t('webdav.serverUrl.name') }));
				return;
			}
			try { new URL(this.webdavUrl); } catch {
				this.submitState.finish();
				this.syncSubmitButtons();
				new Notice(i18n.t('mountManager.urlInvalid'));
				return;
			}
			if (!this.webdavUsername) {
				this.submitState.finish();
				this.syncSubmitButtons();
				new Notice(i18n.t('mountManager.required', { field: i18n.t('webdav.username.name') }));
				return;
			}
			// Require a password on add unless an encrypted one is already stored
			// (e.g. user opens settings on the same device that originally saved it)
			const hasStoredPassword = !!(this.editMount?.encryptedWebdavPassword);
			if (!this.editMount && !this.webdavPassword && !hasStoredPassword) {
				this.submitState.finish();
				this.syncSubmitButtons();
				new Notice(i18n.t('mountManager.required', { field: i18n.t('webdav.password.name') }));
				return;
			}
			if (!this.virtualPath.trim()) {
				this.submitState.finish();
				this.syncSubmitButtons();
				new Notice(i18n.t('mountManager.required', { field: i18n.t('mountManager.virtualPath.name') }));
				return;
			}

			const normalizedVirtual = normalizePath(this.virtualPath.trim());
			const remotePath = this.realPath || '/';

			await this.onSave(
				{
					virtualPath: normalizedVirtual,
					realPath: remotePath,
					enabled: this.editMount ? this.editMount.enabled : true,
					readOnly: this.readOnly,
					label: this.label || undefined,
					addCommand: this.addCommand || undefined,
					priority: this.priority,
					tags: this.tags.length > 0 ? this.tags : undefined,
					enableLargeFileConfirm: this.enableLargeFileConfirm || undefined,
					largeFileThresholdKB: this.largeFileThresholdKB,
					highlightColor: this.highlightColor || undefined,
					mountType: 'webdav',
					webdavUrl: this.webdavUrl,
					webdavUsername: this.webdavUsername,
					// Pass password transiently so plugin can store it under the real mount id
					webdavPassword: this.webdavPassword || undefined,
					visibleFileFilter: this.visibleFileFilter !== 'all' ? this.visibleFileFilter : undefined,
					watcherDebounceMs: undefined,
					watcherUsePolling: undefined,
					watcherPollingIntervalMs: undefined,
					maxFiles: this.maxFiles,
				},
				this.editMount?.id,
			);
			this.close();
			return;
		}

		// ── Local filesystem validation ────────────────────────────────────
		// Fall back to the real folder's base name when no virtual path was typed
		const virtualPathToUse = this.virtualPath.trim()
			|| (this.realPath ? path.basename(this.realPath) : '');

		if (!virtualPathToUse) {
			this.submitState.finish();
			this.syncSubmitButtons();
			new Notice(i18n.t('mountManager.required', { field: i18n.t('mountManager.virtualPath.name') }));
			return;
		}
		if (!this.realPath) {
			this.submitState.finish();
			this.syncSubmitButtons();
			new Notice(i18n.t('mountManager.required', { field: i18n.t('vault.realPath.name') }));
			return;
		}

		const normalizedVirtual = normalizePath(virtualPathToUse);

		// Validate via SecurityManager (dangerous paths, duplicate mounts, etc.)
		const validationError = this.security.validateMount(
			{
				virtualPath: normalizedVirtual,
				realPath: this.realPath,
				fallbackRealPath: this.fallbackRealPath || undefined,
				enabled: true,
				readOnly: this.readOnly,
				label: this.label || undefined,
			},
			[], // Full existing-mount check is done again by the plugin's addMount() / updateMount()
		);
		if (validationError) {
			this.submitState.finish();
			this.syncSubmitButtons();
			new Notice(i18n.t('notice.generic', { message: validationError }));
			return;
		}

		const pathsChanged = !this.editMount || this.editMount.realPath !== this.realPath
			|| (this.editMount.fallbackRealPath ?? '') !== this.fallbackRealPath;
		if (pathsChanged) {
			let accessibleDirectory = false;
			for (const candidate of [this.realPath, this.fallbackRealPath].filter(Boolean)) {
				if (await isDirectory(candidate) && (await checkPathAccessible(candidate)).accessible) {
					accessibleDirectory = true;
					break;
				}
			}
			if (!accessibleDirectory) {
				this.submitState.finish();
				this.syncSubmitButtons();
				new Notice(i18n.t('mountManager.noAccessiblePath'));
				return;
			}
		}

		// Non-blocking advisory warnings (e.g. UNC / network paths)
		const warnings = this.security.getPathWarnings(this.realPath);
		for (const w of warnings) {
			new Notice(i18n.t('notice.warning', { message: w }), 10_000);
		}

		await this.onSave(
			{
				virtualPath: normalizedVirtual,
				realPath: this.realPath,
				fallbackRealPath: this.fallbackRealPath || undefined,
				enabled: this.editMount ? this.editMount.enabled : true,
				readOnly: this.readOnly,
				label: this.label || undefined,
				addCommand: this.addCommand || undefined,
				priority: this.priority,
				tags: this.tags.length > 0 ? this.tags : undefined,
				enableLargeFileConfirm: this.enableLargeFileConfirm || undefined,
				largeFileThresholdKB: this.largeFileThresholdKB,
				highlightColor: this.highlightColor || undefined,
				mountType: this.mountType === 'local' ? undefined : this.mountType,
				watcherDebounceMs: this.watcherDebounceMs,
				watcherUsePolling: this.watcherUsePolling || undefined,
				watcherPollingIntervalMs: this.watcherUsePolling ? this.watcherPollingIntervalMs : undefined,
				visibleFileFilter: this.visibleFileFilter !== 'all' ? this.visibleFileFilter : undefined,
				watcherCreateFilter: this.watcherCreateFilter !== 'all' ? this.watcherCreateFilter : undefined,
				watcherSuppressAllEvents: this.watcherSuppressAllEvents || undefined,
				maxFiles: this.maxFiles,
			},
			this.editMount?.id,
		);

		this.close();
	}

	onClose(): void {
		if (this._closeDropdownHandler) {
			document.removeEventListener('click', this._closeDropdownHandler, true);
			this._closeDropdownHandler = undefined;
		}
		this.contentEl.empty();
	}

	private _closeDropdownHandler?: (e: MouseEvent) => void;
}

// ---------------------------------------------------------------------------
// Status helpers used in the settings tab
// ---------------------------------------------------------------------------

/**
 * Query the live reachability and permission status of a mount point.
 * Called when the settings tab renders the mount list.
 */
export async function getMountStatus(mount: MountPoint): Promise<MountStatus> {
	// Remote mounts (WebDAV, S3, SFTP) have no local filesystem path to check.
	// Their reachability is probed by the plugin's health-check loop separately.
	// Return a placeholder "reachable" status so the settings panel stays clean.
	if (mount.mountType === 'webdav' || mount.mountType === 's3' || mount.mountType === 'sftp') {
		return {
			mount,
			reachable: true,
			readOnly: mount.readOnly,
			error: undefined,
		};
	}
	const { accessible, readOnly, error } = await checkPathAccessible(mount.realPath);
	return {
		mount,
		reachable: accessible,
		readOnly: mount.readOnly || readOnly,
		error,
	};
}
