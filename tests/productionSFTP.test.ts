import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import type { Connection, Server as SSHServer } from 'ssh2';

interface BundledClient {
    connect(options: {
        host: string; port: number; username: string; password: string;
        retries: number; readyTimeout: number;
        hostVerifier: (key: Buffer, verify: (accepted: boolean) => void) => void;
    }): Promise<void>;
    stat(path: string): Promise<{ size: number }>;
    end(): Promise<void>;
}

const runtimeRequire = createRequire(import.meta.url);
const { Server } = runtimeRequire('ssh2') as typeof import('ssh2');
let directory: string;
let dependencies: string;

function bundledModule(modulePath: string): unknown {
    const escaped = modulePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = dependencies.match(new RegExp(`// ${escaped}\\r?\\nvar (\\w+) = __commonJS\\(`));
    if (!match) throw new Error(`Production bundle module not found: ${modulePath}`);
    const result = { exports: undefined };
    runInNewContext(`${dependencies}\nmodule.exports = ${match[1]}();`, {
        module: result, require: runtimeRequire, Buffer, process, console,
        __dirname: directory, __filename: join(directory, 'main.js'),
        setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate,
        URL, TextDecoder, TextEncoder,
    });
    return result.exports;
}

describe('production SFTP bundle', () => {
    beforeAll(() => {
        directory = mkdtempSync(join(tmpdir(), 'folderbridge-production-sftp-'));
        const output = join(directory, 'main.js');
        execFileSync(process.execPath, ['esbuild.config.mjs', 'production'], {
            env: { ...process.env, FOLDERBRIDGE_BUILD_OUTFILE: output },
            stdio: 'pipe',
        });
        const bundle = readFileSync(output, 'utf8');
        const boundary = bundle.indexOf('// main.ts');
        if (boundary < 0) throw new Error('Production bundle entry boundary not found');
        // Evaluate the actual bundled dependency wrappers without starting the Obsidian plugin.
        dependencies = bundle.slice(0, boundary);
    }, 30000);

    afterAll(() => {
        if (directory) rmSync(directory, { recursive: true, force: true });
    });

    it.each([
        'node-native-stub:../build/Release/cpufeatures.node',
        'node-native-stub:./crypto/build/Release/sshcrypto.node',
    ])('%s throws during require, not during first use', modulePath => {
        expect(() => bundledModule(modulePath)).toThrow('Native module not available in bundled context:');
    });

    it.each(['aes128-gcm@openssh.com', 'aes128-ctr'] as const)(
        'authenticates and exchanges encrypted SFTP packets using %s', async cipher => {
            const Client = bundledModule('node_modules/ssh2-sftp-client/src/index.js') as new () => BundledClient;
            const client = new Client();
            const connections = new Set<Connection>();
            const errors: Error[] = [];
            const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
                .privateKey.export({ type: 'pkcs1', format: 'pem' });
            let server: SSHServer | undefined;
            try {
                server = new Server({ hostKeys: [key], algorithms: { cipher: [cipher] } }, connection => {
                    connections.add(connection);
                    connection.on('error', error => errors.push(error));
                    connection.on('authentication', context => {
                        if (context.method === 'password' && context.username === 'tester' && context.password === 'test-only') context.accept();
                        else context.reject();
                    });
                    connection.on('ready', () => connection.on('session', accept => {
                        accept().on('sftp', acceptSFTP => {
                            const sftp = acceptSFTP();
                            sftp.on('STAT', (request, path) => {
                                expect(path).toBe('/note.md');
                                sftp.attrs(request, { size: 4, mode: 0o100644, uid: 0, gid: 0, atime: 0, mtime: 0 });
                            });
                        });
                    }));
                });
                await new Promise<void>((resolve, reject) => {
                    server!.on('error', reject);
                    server!.listen(0, '127.0.0.1', resolve);
                });
                const address = server.address();
                if (!address || typeof address === 'string') throw new Error('Expected loopback server address');
                await client.connect({
                    host: '127.0.0.1', port: address.port, username: 'tester', password: 'test-only',
                    retries: 0, readyTimeout: 5000, hostVerifier: (_key, verify) => verify(true),
                });
                expect(await client.stat('/note.md')).toMatchObject({ size: 4 });
                expect(errors).toEqual([]);
            } finally {
                await client.end();
                for (const connection of connections) connection.end();
                if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
            }
        }, 15000,
    );
});
