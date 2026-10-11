import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VirtualAdapter } from '../src/VirtualAdapter';
import { PathMapper } from '../src/PathMapper';
import { SecurityManager } from '../src/SecurityManager';
import { DEFAULT_SETTINGS } from '../src/types';

describe('copy-first local conflict protection', () => {
    const directories: string[] = [];
    afterEach(async () => {
        vi.restoreAllMocks();
        for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
    });

    async function setup() {
        const root = await fs.mkdtemp(join(tmpdir(), 'folderbridge-conflict-'));
        directories.push(root);
        const source = join(root, 'source');
        const vault = join(root, 'vault');
        await fs.mkdir(source);
        await fs.mkdir(vault);
        const mapper = new PathMapper();
        mapper.update([{ id: 'm', virtualPath: 'Mounted', realPath: source, enabled: true, readOnly: false }]);
        const onModify = vi.fn().mockResolvedValue(undefined);
        const adapter = new VirtualAdapter({ getBasePath: () => vault }, mapper, new SecurityManager([source]),
            false, 1024, async () => 'cancel', async () => {}, () => false, onModify);
        adapter.getKnownMtime = () => 1;
        const file = join(source, 'note.md');
        await fs.writeFile(file, 'original');
        const conflicts = join(vault, '.trash', 'folderbridge-conflicts');
        async function copies() {
            try {
                const names = await fs.readdir(conflicts);
                return await Promise.all(names.map(async name => {
                    const path = join(conflicts, name, 'note.md');
                    return { path, bytes: await fs.readFile(path) };
                }));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
                throw error;
            }
        }
        return { adapter, file, conflicts, copies, onModify, mapper, source, vault };
    }

    it('defaults existing users to copy, not automatic merge', () => {
        expect(DEFAULT_SETTINGS.localConflictMode).toBe('copy');
    });

    it('preserves same-size external changes even when mtime is unchanged', async () => {
        const { adapter, file, copies } = await setup();
        await adapter.read('Mounted/note.md');
        const original = await fs.stat(file);
        await fs.writeFile(file, 'external');
        await fs.utimes(file, original.atime, original.mtime);
        await adapter.write('Mounted/note.md', 'my draft');
        expect(await fs.readFile(file, 'utf8')).toBe('my draft');
        expect((await copies()).map(copy => copy.bytes.toString())).toEqual(['external']);
    });

    it('preserves unverified content when no read baseline exists', async () => {
        const { adapter, copies } = await setup();
        await adapter.write('Mounted/note.md', 'mine');
        expect((await copies()).map(copy => copy.bytes.toString())).toEqual(['original']);
    });

    it('does not classify quick saves or identical content as external edits', async () => {
        const { adapter, copies } = await setup();
        await adapter.read('Mounted/note.md');
        await adapter.write('Mounted/note.md', 'first');
        await adapter.write('Mounted/note.md', 'second');
        await adapter.write('Mounted/note.md', 'second');
        expect(await copies()).toEqual([]);
    });

    it('does not let a later background read hide a conflict with the older editor', async () => {
        const { adapter, file, copies } = await setup();
        await adapter.read('Mounted/note.md');
        await fs.writeFile(file, 'external');
        await adapter.read('Mounted/note.md');
        await adapter.write('Mounted/note.md', 'stale editor');
        expect((await copies()).map(copy => copy.bytes.toString())).toEqual(['external']);
    });

    it('protects binary content without decoding or merging', async () => {
        const { adapter, file, copies } = await setup();
        await adapter.readBinary('Mounted/note.md');
        const external = Buffer.from([255, 0, 128]);
        await fs.writeFile(file, external);
        await adapter.writeBinary('Mounted/note.md', new Uint8Array([1, 2]).buffer);
        expect((await copies()).map(copy => copy.bytes)).toEqual([external]);
        expect(await fs.readFile(file)).toEqual(Buffer.from([1, 2]));
    });

    it('refuses a save if the permanent conflict copy cannot be made', async () => {
        const { adapter, file, onModify } = await setup();
        const originalWrite = fs.writeFile.bind(fs);
        vi.spyOn(fs, 'writeFile').mockImplementation(async (destination, data, options) => {
            if (String(destination).includes('folderbridge-conflicts')) throw new Error('backup denied');
            return originalWrite(destination, data, options);
        });
        await expect(adapter.write('Mounted/note.md', 'mine')).rejects.toThrow('changed version could not be preserved');
        expect(await fs.readFile(file, 'utf8')).toBe('original');
        expect(onModify).not.toHaveBeenCalled();
    });

    it('retains conflict and safety copies and names both after a failed write', async () => {
        const { adapter, file, copies } = await setup();
        const originalWrite = fs.writeFile.bind(fs);
        vi.spyOn(fs, 'writeFile').mockImplementation(async (destination, data, options) => {
            if (destination === file) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
            return originalWrite(destination, data, options);
        });
        const error = await adapter.write('Mounted/note.md', 'mine').then(() => null, (error: Error) => error);
        const retained = await copies();
        expect(retained).toHaveLength(1);
        expect(error?.message).toContain(retained[0].path);
        expect(error?.message).toContain('folderbridge-saving');
        expect(retained[0].bytes.toString()).toBe('original');
    });

    it('explicit overwrite skips conflict copies but still requires a safety copy', async () => {
        const { adapter, file, copies } = await setup();
        adapter.getConflictMode = () => 'overwrite';
        vi.spyOn(fs, 'copyFile').mockRejectedValue(new Error('backup denied'));
        await expect(adapter.write('Mounted/note.md', 'mine')).rejects.toThrow('safety copy could not be made');
        expect(await copies()).toEqual([]);
        expect(await fs.readFile(file, 'utf8')).toBe('original');
    });

    it('serializes saves of the same physical path, preventing our own false conflicts', async () => {
        const { adapter, file, copies } = await setup();
        await adapter.read('Mounted/note.md');
        const originalWrite = fs.writeFile.bind(fs);
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        let started!: () => void;
        const firstStarted = new Promise<void>(resolve => { started = resolve; });
        const writes: string[] = [];
        vi.spyOn(fs, 'writeFile').mockImplementation(async (destination, data, options) => {
            if (destination === file) {
                writes.push(String(data));
                if (data === 'first') { started(); await gate; }
            }
            return originalWrite(destination, data, options);
        });
        const first = adapter.write('Mounted/note.md', 'first');
        await firstStarted;
        const second = adapter.write('Mounted/note.md', 'second');
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(writes).toEqual(['first']);
        release();
        await Promise.all([first, second]);
        expect(await fs.readFile(file, 'utf8')).toBe('second');
        expect(await copies()).toEqual([]);
    });

    it('does not reuse a baseline after the mount is rerouted', async () => {
        const { adapter, mapper, source, copies } = await setup();
        await adapter.read('Mounted/note.md');
        const replacement = join(source, 'replacement');
        await fs.mkdir(replacement);
        await fs.writeFile(join(replacement, 'note.md'), 'other route');
        mapper.setResolvedPath('m', replacement);
        await adapter.write('Mounted/note.md', 'mine');
        expect((await copies()).map(copy => copy.bytes.toString())).toEqual(['other route']);
    });

    it('refuses in-flight and queued saves if routing changes during backup', async () => {
        const { adapter, mapper, source, file } = await setup();
        await adapter.read('Mounted/note.md');
        const replacement = join(source, 'replacement');
        await fs.mkdir(replacement);
        await fs.writeFile(join(replacement, 'note.md'), 'other route');
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        let started!: () => void;
        const backedUp = new Promise<void>(resolve => { started = resolve; });
        const originalCopy = fs.copyFile.bind(fs);
        vi.spyOn(fs, 'copyFile').mockImplementation(async (source, destination, mode) => {
            await originalCopy(source, destination, mode);
            started();
            await gate;
        });
        const first = adapter.write('Mounted/note.md', 'first');
        await backedUp;
        const second = adapter.write('Mounted/note.md', 'second');
        mapper.setResolvedPath('m', replacement);
        const results = Promise.allSettled([first, second]);
        release();
        expect((await results).every(result => result.status === 'rejected')).toBe(true);
        expect(await fs.readFile(file, 'utf8')).toBe('original');
        expect(await fs.readFile(join(replacement, 'note.md'), 'utf8')).toBe('other route');
    });

    it('preserves vault.process results without automatic editor reload', async () => {
        const { adapter, file, copies } = await setup();
        const result = await adapter.process('Mounted/note.md', text => text + ' processed');
        expect(result).toBe('original processed');
        expect(await fs.readFile(file, 'utf8')).toBe(result);
        expect(await copies()).toEqual([]);
    });

    it.each(['append', 'appendBinary'] as const)('tracks our own %s before a subsequent save', async operation => {
        const { adapter, copies } = await setup();
        await adapter.read('Mounted/note.md');
        if (operation === 'append') await adapter.append('Mounted/note.md', ' appended');
        else await adapter.appendBinary('Mounted/note.md', new TextEncoder().encode(' appended').buffer);
        await adapter.write('Mounted/note.md', 'next edit');
        expect(await copies()).toEqual([]);
    });

    it('serializes two process transformations without losing the first change', async () => {
        const { adapter, file, copies } = await setup();
        await Promise.all([
            adapter.process('Mounted/note.md', text => text + ' first'),
            adapter.process('Mounted/note.md', text => text + ' second'),
        ]);
        expect(await fs.readFile(file, 'utf8')).toBe('original first second');
        expect(await copies()).toEqual([]);
    });
});
