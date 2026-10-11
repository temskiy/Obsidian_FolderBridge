import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeText } from '../src/textEncoding';
import { VirtualAdapter } from '../src/VirtualAdapter';
import { PathMapper } from '../src/PathMapper';
import { SecurityManager } from '../src/SecurityManager';

describe('encoding-safe local saves', () => {
    const directories: string[] = [];
    afterEach(async () => {
        vi.restoreAllMocks();
        for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
    });
    async function setup() {
        const directory = await fs.mkdtemp(join(tmpdir(), 'folderbridge-encoding-'));
        directories.push(directory);
        const mount = { id: 'm', virtualPath: 'Mounted', realPath: directory, enabled: true, readOnly: false };
        const mapper = new PathMapper();
        mapper.update([mount]);
        return {
            file: join(directory, 'note.md'),
            adapter: new VirtualAdapter({ getBasePath: () => directory }, mapper, new SecurityManager([directory]), false, 1024,
                async () => 'cancel', async () => {}, () => false),
        };
    }
    it('maps the entire CP1252 special range consistently across Node builds', () => {
        const bytes = Uint8Array.from(Array.from({ length: 32 }, (_, index) => index + 0x80));
        expect([...decodeText(bytes).text].map(value => value.codePointAt(0))).toEqual([
            0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021,
            0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
            0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
            0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
        ]);
    });
    it.each([
        [Buffer.from([0xa3, 0x96, 0xe9]), '\u00a3\u2013\u00e9'],
        [Buffer.from([0xff, 0xfe, 0x68, 0, 0x69, 0]), 'hi'],
        [Buffer.from([0xfe, 0xff, 0, 0x68, 0, 0x69]), 'hi'],
    ])('reads legacy bytes and refuses both write and append without prior read', async (bytes, text) => {
        const { file, adapter } = await setup();
        await fs.writeFile(file, bytes);
        await expect(adapter.write('Mounted/note.md', 'new')).rejects.toThrow('not stored as UTF-8');
        await expect(adapter.append('Mounted/note.md', 'new')).rejects.toThrow('not stored as UTF-8');
        expect(await adapter.read('Mounted/note.md')).toBe(text);
        expect(await fs.readFile(file)).toEqual(bytes);
    });
    it('rechecks an externally replaced formerly UTF-8 note', async () => {
        const { file, adapter } = await setup();
        await fs.writeFile(file, 'old');
        await adapter.read('Mounted/note.md');
        await fs.writeFile(file, Buffer.from([0x96]));
        await expect(adapter.write('Mounted/note.md', 'new')).rejects.toThrow('not stored as UTF-8');
    });
    it('permits a converted UTF-8 note and preserves a BOM', async () => {
        const { file, adapter } = await setup();
        await fs.writeFile(file, Buffer.from([0x96]));
        await adapter.read('Mounted/note.md');
        await fs.writeFile(file, '\ufeffhello');
        const text = await adapter.read('Mounted/note.md');
        await adapter.write('Mounted/note.md', text + '!');
        expect(await fs.readFile(file, 'utf8')).toBe('\ufeffhello!');
    });
    it('refuses a save when encoding verification cannot read the file', async () => {
        const { file, adapter } = await setup();
        await fs.writeFile(file, 'old');
        vi.spyOn(fs, 'readFile').mockRejectedValue(Object.assign(new Error('access denied'), { code: 'EACCES' }));
        const write = vi.spyOn(fs, 'writeFile');
        await expect(adapter.write('Mounted/note.md', 'new')).rejects.toThrow('Could not verify text encoding');
        expect(write).not.toHaveBeenCalled();
    });
});
