import { normalizePath } from 'obsidian';
import { MountPoint, MountType } from './types';
import { loadOptionalNodeModule } from './runtimeNode';
import { logger } from './logger';
import { i18n } from './i18n';

// Lazy-loaded — unavailable on Obsidian Mobile (Capacitor).
const fs: typeof import('fs') = loadOptionalNodeModule<typeof import('fs')>('fs') ?? null as never;
const path: typeof import('path') = loadOptionalNodeModule<typeof import('path')>('path') ?? null as never;

// ---------------------------------------------------------------------------
// Type: Destination option for picker modals
// ---------------------------------------------------------------------------

export interface DestinationOption {
	id: string;            // 'vault' or mount.id
	name: string;          // Display name
	type: 'vault' | MountType;
	reachable: boolean;    // Whether the destination is currently accessible
}

// ---------------------------------------------------------------------------
// Size calculation
// ---------------------------------------------------------------------------

/**
 * Calculate the total size of a file or directory in bytes.
 * For local mounts uses Node fs; for cloud mounts delegates to the adapter.
 * Returns -1 on error.
 */
export async function calculateSizeInBytes(
	realPath: string,
	mountType: MountType,
	serverPath?: string,
	webdavReadBinary?: (p: string) => Promise<ArrayBuffer>,
	s3ReadBinary?: (p: string) => Promise<ArrayBuffer>,
	sftpReadBinary?: (p: string) => Promise<ArrayBuffer>,
): Promise<number> {
	try {
		if (mountType === 'webdav' && webdavReadBinary && serverPath) {
			const buf = await webdavReadBinary(serverPath);
			return buf.byteLength;
		}
		if (mountType === 's3' && s3ReadBinary && serverPath) {
			const buf = await s3ReadBinary(serverPath);
			return buf.byteLength;
		}
		if (mountType === 'sftp' && sftpReadBinary && serverPath) {
			const buf = await sftpReadBinary(serverPath);
			return buf.byteLength;
		}
		// Local mount
		if (fs?.promises) {
			const stat = await fs.promises.stat(realPath);
			if (stat.isDirectory()) {
				return await calculateDirectorySizeRecursive(realPath);
			}
			return stat.size;
		}
		return -1;
	} catch (error) {
		logger.debug(`[FolderBridge] Failed to calculate size for "${realPath}":`, error);
		return -1;
	}
}

/**
 * Recursively calculate directory size in bytes.
 * Limited to 100 000 entries to prevent hangs on huge directories.
 */
async function calculateDirectorySizeRecursive(dirPath: string): Promise<number> {
	let totalSize = 0;
	const MAX_ENTRIES = 100000;

	try {
		const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
		let count = 0;

		for (const entry of entries) {
			if (count >= MAX_ENTRIES) {
				logger.warn(`[FolderBridge] Size calculation limited to ${MAX_ENTRIES} entries for "${dirPath}"`);
				break;
			}
			count++;

			const fullPath = path.join(dirPath, entry.name);
			try {
				if (entry.isDirectory()) {
					totalSize += await calculateDirectorySizeRecursive(fullPath);
				} else if (entry.isFile()) {
					const stat = await fs.promises.stat(fullPath);
					totalSize += stat.size;
				}
			} catch {
				// Skip inaccessible files
			}
		}
	} catch (error) {
		logger.debug(`[FolderBridge] Failed to recurse directory "${dirPath}":`, error);
	}

	return totalSize;
}

/**
 * Convert bytes to human-readable string (KB, MB, GB).
 */
export function formatSizeBytes(bytes: number): string {
	if (bytes < 0) return 'Unknown';
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/**
 * Convert bytes to kilobytes (rounded up).
 */
export function bytesToKilobytes(bytes: number): number {
	return Math.ceil(bytes / 1024);
}

// ---------------------------------------------------------------------------
// Destination resolution
// ---------------------------------------------------------------------------

/**
 * Get all available destinations for copy/move/create operations.
 * Returns vault + all enabled mounts with reachability status.
 */
export function getAvailableDestinations(
	mounts: MountPoint[],
	mountHealthMap: Map<string, boolean>,
): DestinationOption[] {
	const destinations: DestinationOption[] = [];

	// Always include the local vault
	destinations.push({
		id: 'vault',
		name: 'Local vault',
		type: 'vault',
		reachable: true,
	});

	// Add all enabled mounts
	for (const mount of mounts) {
		if (!mount.enabled) continue;

		const reachable = mountHealthMap.get(mount.id) ?? true;
		destinations.push({
			id: mount.id,
			name: mount.label || mount.virtualPath || `Mount (${mount.id})`,
			type: mount.mountType ?? 'local',
			reachable,
		});
	}

	return destinations;
}

/**
 * Resolve the destination mount and real path for a given virtual path.
 * Returns { mount: null, realPath: virtualPath } for vault paths.
 */
export function resolveDestination(
	virtualPath: string,
	mounts: MountPoint[],
	defaultCreationVault: string,
): { mount: MountPoint | null; realPath: string; mountType: MountType | 'vault' } {
	const normalized = normalizePath(virtualPath);

	// Check if path is inside any mount
	for (const mount of mounts) {
		if (!mount.enabled) continue;

		const mountVirtual = normalizePath(mount.virtualPath);
		if (normalized === mountVirtual || normalized.startsWith(mountVirtual + '/')) {
			return {
				mount,
				realPath: mount.realPath,
				mountType: mount.mountType ?? 'local',
			};
		}
	}

	// Default to vault
	if (defaultCreationVault === 'vault') {
		return {
			mount: null,
			realPath: virtualPath,
			mountType: 'vault',
		};
	}

	// defaultCreationVault is a mount id — find it
	const defaultMount = mounts.find(m => m.id === defaultCreationVault && m.enabled);
	if (defaultMount) {
		return {
			mount: defaultMount,
			realPath: defaultMount.realPath,
			mountType: defaultMount.mountType ?? 'local',
		};
	}

	// Fallback to vault if default mount not found or disabled
	return {
		mount: null,
		realPath: virtualPath,
		mountType: 'vault',
	};
}

/**
 * Check if a mount supports write operations.
 */
export function isMountWritable(mount: MountPoint): boolean {
	return !mount.readOnly;
}

/**
 * Get the display name for a mount type.
 */
export function getMountTypeLabel(type: MountType | 'vault'): string {
	switch (type) {
		case 'vault':
			return i18n.t('mountTypeShort.vault');
		case 'local':
			return i18n.t('mountTypeShort.local');
		case 'webdav':
			return i18n.t('mountTypeShort.webdav');
		case 's3':
			return i18n.t('mountTypeShort.s3');
		case 'sftp':
			return i18n.t('mountTypeShort.sftp');
		default:
			return type;
	}
}

/**
 * Get the icon class for a mount type (Obsidian icon classes).
 */
export function getMountTypeIcon(type: MountType | 'vault'): string {
	switch (type) {
		case 'vault':
			return 'book';
		case 'local':
			return 'folder';
		case 'webdav':
			return 'globe';
		case 's3':
			return 'cloud';
		case 'sftp':
			return 'server';
		default:
			return 'link';
	}
}
