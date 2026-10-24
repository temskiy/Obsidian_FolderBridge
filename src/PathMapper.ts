import { normalizePath } from 'obsidian';
import { MountPoint } from './types';
import { loadOptionalNodeModule } from './runtimeNode';
// Node.js builtins are lazy-loaded so the plugin still loads on mobile
const path: typeof import('path') = loadOptionalNodeModule<typeof import('path')>('path') ?? null as never;

/**
 * PathMapper maintains the list of active mount points and provides
 * bidirectional translation between vault-relative virtual paths and
 * real absolute filesystem paths.
 *
 * All vault paths are "normalized" (forward slashes, no leading slash),
 * matching the format Obsidian uses internally.
 */
export class PathMapper {
	private mounts: MountPoint[] = [];
	private currentDeviceId: string = '';

	/**
	 * Pre-sorted, pre-normalized cache rebuilt by update().
	 * Sorted descending by normalizedVirtualPath.length so that the
	 * most-specific (longest) mount always wins when paths overlap.
	 * Avoids allocating a new sorted array and re-calling normalizePath
	 * on every getMountForPath() invocation (which fires on every I/O op).
	 */
	private sortedMountCache: ReadonlyArray<{
		mount: MountPoint;
		normalizedVirtualPath: string;
	}> = [];

	/** Runtime-resolved fallback paths keyed by mount id. */
	private resolvedRealPaths: Map<string, string> = new Map();
	private rootConfigurations = new Map<string, string>();

	/** Replace the active mount list (call after settings change). */
	update(mounts: MountPoint[], deviceId: string = ''): void {
		this.currentDeviceId = deviceId;
		this.mounts = mounts.filter(m => m.enabled);
		// Build a sorted, pre-normalized lookup cache so hot-path methods
		// (getMountForPath, getMountByVirtualPath, …) never sort or normalize
		// inside their loops.
		this.sortedMountCache = this.mounts
			.map(m => ({ mount: m, normalizedVirtualPath: normalizePath(m.virtualPath) }))
			.sort((a, b) => {
				// Primary sort: highest priority first (descending)
				const priorityDiff = (b.mount.priority ?? 0) - (a.mount.priority ?? 0);
				if (priorityDiff !== 0) return priorityDiff;
				// Secondary sort: longest (most specific) virtual path first
				return b.normalizedVirtualPath.length - a.normalizedVirtualPath.length;
			});
		const rootConfigurations = new Map(this.mounts.map(mount => [mount.id, JSON.stringify([
			deviceId, mount.realPath, mount.fallbackRealPath, mount.deviceOverrides?.[deviceId], mount.mountType,
		])]));
		for (const id of this.resolvedRealPaths.keys()) {
			if (!rootConfigurations.has(id) || rootConfigurations.get(id) !== this.rootConfigurations.get(id)) {
				this.resolvedRealPaths.delete(id);
			}
		}
		this.rootConfigurations = rootConfigurations;
	}

	setResolvedPath(mountId: string, resolvedPath: string): void {
		this.resolvedRealPaths.set(mountId, resolvedPath);
	}

	clearResolvedPath(mountId: string): void {
		this.resolvedRealPaths.delete(mountId);
	}

	getMounts(): MountPoint[] {
		return this.mounts;
	}

	/**
	 * Gets the effective real path for a mount on this specific device,
	 * falling back to the original realPath if no override exists.
	 */
	getEffectiveRealPath(mount: MountPoint): string {
		if (this.currentDeviceId && mount.deviceOverrides && mount.deviceOverrides[this.currentDeviceId]) {
			return mount.deviceOverrides[this.currentDeviceId];
		}
		if (this.resolvedRealPaths.has(mount.id)) {
			return this.resolvedRealPaths.get(mount.id)!;
		}
		return mount.realPath;
	}

	/**
	 * Returns the mount whose virtualPath exactly matches the given path.
	 * Used to detect "this IS a mount root" checks.
	 */
	getMountByVirtualPath(virtualPath: string): MountPoint | undefined {
		const n = normalizePath(virtualPath);
		// Find all mounts with exact path match, return the one with highest priority
		const exactMatches = this.sortedMountCache
			.filter(({ normalizedVirtualPath }) => normalizedVirtualPath === n)
			.map(({ mount }) => mount)
			.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
		return exactMatches[0];
	}

	/**
	 * Returns the mount that owns the given virtual path (the path is the
	 * mount root OR a descendant of it).  Returns undefined if the path
	 * lives entirely inside the real vault.
	 */
	/**
	 * Returns all mounts that cover the given virtual path
	 * (the path is the mount root OR a descendant of it),
	 * sorted by priority (highest first).
	 * Used for conflict resolution when multiple mounts overlap.
	 */
	getMountsForPath(virtualPath: string): MountPoint[] {
		const n = normalizePath(virtualPath);
		// Collect all mounts that cover this path
		const candidates = this.sortedMountCache
			.filter(({ normalizedVirtualPath: mv }) => n === mv || n.startsWith(mv + '/'))
			.map(({ mount }) => mount);
		// Sort by priority (highest first), then by path length (longest first)
		return candidates.sort((a, b) => {
			const priorityDiff = (b.priority ?? 0) - (a.priority ?? 0);
			if (priorityDiff !== 0) return priorityDiff;
			// Equal priority: longer (more specific) path wins
			return normalizePath(b.virtualPath).length - normalizePath(a.virtualPath).length;
		});
	}

	getMountForPath(virtualPath: string): MountPoint | undefined {
		// Return the mount with the highest priority that covers this path.
		// If no mount covers it, the path belongs to the local vault.
		const candidates = this.getMountsForPath(virtualPath);
		return candidates.length > 0 ? candidates[0] : undefined;
	}

	/** True if virtualPath is a mount root or inside a mount. */
	/**
	 * Resolves conflicts between files/folders with the same name
	 * from different sources (mounts or the local vault).
	 *
	 * Algorithm:
	 * 1. Select candidates with the highest priority
	 * 2. If multiple candidates remain, apply conflictResolution rule:
	 *    - 'folders-win': if any folder exists, keep only folders
	 *    - 'files-win': if any file exists, keep only files
	 * 3. If still multiple candidates, use alphabetical order of realPath
	 *    as the final tie-breaker (deterministic fallback).
	 */
	resolveConflict<T extends {
		path: string;
		type: 'file' | 'folder';
		priority: number;
		realPath: string;
	}>(
		candidates: T[],
		conflictResolution: 'folders-win' | 'files-win' = 'folders-win',
	): T | null {
		if (candidates.length === 0) return null;
		if (candidates.length === 1) return candidates[0];

		// Step 1: Find the highest priority
		const maxPriority = Math.max(...candidates.map(c => c.priority));
		let winners = candidates.filter(c => c.priority === maxPriority);
		if (winners.length === 1) return winners[0];
	
		// Step 2: Apply conflictResolution rule
		if (conflictResolution === 'folders-win') {
			const folders = winners.filter(w => w.type === 'folder');
			if (folders.length > 0) winners = folders;
		} else if (conflictResolution === 'files-win') {
			const files = winners.filter(w => w.type === 'file');
			if (files.length > 0) winners = files;
		}
		if (winners.length === 1) return winners[0];
	
		// Step 3: Final tie-breaker — alphabetical order of realPath
		winners.sort((a, b) => a.realPath.localeCompare(b.realPath));
		return winners[0];
	}

	isInsideMount(virtualPath: string): boolean {
		return this.getMountForPath(virtualPath) !== undefined;
	}

	/**
	 * Translate a virtual vault path to the real filesystem path using
	 * the provided mount.  The mount must be the one returned by
	 * getMountForPath() for this virtualPath.
	 */
	toRealPath(virtualPath: string, mount: MountPoint): string {
		const n = normalizePath(virtualPath);
		const mv = normalizePath(mount.virtualPath);
		const effectiveRealPath = this.getEffectiveRealPath(mount);

		if (n === mv) return effectiveRealPath;
		const relative = n.slice(mv.length + 1); // strip "mount/" prefix
		// On Windows path.join handles backslash; on POSIX it stays as '/'
		return path.join(effectiveRealPath, ...relative.split('/'));
	}

	/**
	 * Translate a real filesystem path back to a virtual vault path.
	 * Only valid if realPath is inside mount.realPath.
	 */
	toVirtualPath(realPath: string, mount: MountPoint): string {
		const effectiveRealPath = this.getEffectiveRealPath(mount);
		const rel = path.relative(effectiveRealPath, realPath);
		if (!rel || rel.startsWith('..')) return normalizePath(mount.virtualPath);
		return normalizePath(mount.virtualPath + '/' + rel.split(path.sep).join('/'));
	}

	/**
	 * Returns the normalized virtual paths of mounts that are DIRECT children
	 * of parentVirtualPath.  Used to inject virtual folders into vault listings.
	 *
	 * parentVirtualPath === '' means the vault root.
	 */
	getVirtualMountsDirectChildren(parentVirtualPath: string): string[] {
		const parent = parentVirtualPath === '' ? '' : normalizePath(parentVirtualPath);
		const result: string[] = [];

		for (const { normalizedVirtualPath: mv } of this.sortedMountCache) {
			if (parent === '') {
				// Root: return the first path component of each mount so that
				// intermediate virtual folders (e.g. "Projects" for a mount at
				// "Projects/Work") also appear in the vault root listing.
				const firstSlash = mv.indexOf('/');
				const directChild = firstSlash === -1 ? mv : mv.slice(0, firstSlash);
				if (!result.includes(directChild)) result.push(directChild);
			} else {
				// Non-root: include the first direct child under this parent,
				// whether it is the mount itself or an intermediate virtual folder.
				if (mv.startsWith(parent + '/')) {
					const remainder = mv.slice(parent.length + 1);
					const nextSlash = remainder.indexOf('/');
					const directChild = nextSlash === -1
						? mv
						: parent + '/' + remainder.slice(0, nextSlash);
					if (!result.includes(directChild)) result.push(directChild);
				}
			}
		}

		return result;
	}

	/**
	 * True if any active mount is the given path or a descendant/child.
	 * Used to decide whether a non-existent vault directory should
	 * "appear to exist" because it is a virtual parent of a mount.
	 */
	hasMountsUnder(virtualPath: string): boolean {
		const n = virtualPath === '' ? '' : normalizePath(virtualPath);
		return this.sortedMountCache.some(
			({ normalizedVirtualPath: mv }) => mv === n || mv.startsWith(n === '' ? '' : n + '/')
		);
	}
}
