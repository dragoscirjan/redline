import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnalysisSocketPath, disposeAnalysis, type PreparedAnalysis } from '../src/harness-executor/analysis.ts';

afterEach(() => vi.unstubAllEnvs());
describe.skipIf(process.platform === 'win32')('private analysis Unix socket', () => {
  it('binds below platform limits even when TMPDIR and workDirectory are long, then removes its directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'redline-socket-test-'));
    const temporary = join(root, 'long-' + 'x'.repeat(100));
    await mkdir(temporary);
    const manifestFile = join(temporary, 'redline-review-123456', 'analysis', 'manifest.json');
    expect(Buffer.byteLength(join(dirname(manifestFile), 'cgc/database/falkordb.sock'))).toBeGreaterThan(104);
    vi.stubEnv('TMPDIR', temporary);
    let path: string | undefined;
    let shutdown = '';
    const server = createServer(socket => {
      socket.on('data', chunk => { shutdown += String(chunk); });
      socket.on('end', () => { socket.end(); });
    });
    try {
      path = await createAnalysisSocketPath();
      expect(Buffer.byteLength(path)).toBeLessThan(104);
      expect(path.startsWith(temporary)).toBe(false);
      expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject); server.listen(path, resolve);
      });
      const prepared: PreparedAnalysis = { manifestFile, command: '', launcher: '', statuses: [], backends: [], cgcSocketPath: path };
      await disposeAnalysis(prepared);
      expect(shutdown).toBe('*2\r\n$8\r\nSHUTDOWN\r\n$6\r\nNOSAVE\r\n');
      await expect(stat(dirname(path))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (path !== undefined) await rm(dirname(path), { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
  it('does not remove a directory it did not allocate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'redline-unowned-socket-'));
    try {
      await disposeAnalysis({ manifestFile: '', command: '', launcher: '', statuses: [], backends: [], cgcSocketPath: join(root, 'f.sock') });
      expect((await stat(root)).isDirectory()).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('removes the private directory when no database socket started', async () => {
    const path = await createAnalysisSocketPath();
    try {
      await disposeAnalysis({ manifestFile: '', command: '', launcher: '', statuses: [], backends: [], cgcSocketPath: path });
      await expect(stat(dirname(path))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(dirname(path), { recursive: true, force: true }); }
  });
});
