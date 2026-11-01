import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { digest, inspectCandidate, combinePlatforms, OciRegistry, OCI_INDEX, OCI_MANIFEST } from '../src/release/oci.ts';
import { GitHubReleases } from '../src/release/github.ts';
import { recordIdentity } from '../src/release/coordinator.ts';
import { npmIntegrity, waitForIdentity } from '../src/release/npm-registry.ts';
import { releaseAssetBytes, releaseFixture } from './helpers/release.ts';
const roots: string[] = []; const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function listen(server: Server): Promise<string> {
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No loopback address'); return 'http://127.0.0.1:' + address.port;
}
async function archive(architecture: 'amd64' | 'arm64') {
  const root = await mkdtemp(join(tmpdir(), 'redline-oci-fixture-')); roots.push(root);
  const data = join(root, 'data'); await mkdir(join(data, 'blobs/sha256'), { recursive: true });
  const config = Buffer.from(JSON.stringify({ architecture, os: 'linux', config: {}, rootfs: { type: 'layers', diff_ids: [] } }));
  const layer = Buffer.from('Synthetic layer, not a runtime image.');
  const blob = (bytes: Buffer, mediaType: string) => ({ mediaType, digest: digest(bytes), size: bytes.length });
  const document = { schemaVersion: 2, mediaType: OCI_MANIFEST, config: blob(config, 'application/vnd.oci.image.config.v1+json'), layers: [blob(layer, 'application/vnd.oci.image.layer.v1.tar')] };
  const bytes = Buffer.from(JSON.stringify(document)); const descriptor = { ...blob(bytes, OCI_MANIFEST), platform: { os: 'linux', architecture } };
  for (const value of [config, layer, bytes]) await writeFile(join(data, 'blobs/sha256', digest(value).slice(7)), value);
  await writeFile(join(data, 'index.json'), JSON.stringify({ schemaVersion: 2, mediaType: OCI_INDEX, manifests: [descriptor] }));
  const path = join(root, 'image.tar'); execFileSync('tar', ['-cf', path, '-C', data, 'index.json', 'blobs'], { env: { PATH: process.env.PATH, LANG: 'C' } });
  return inspectCandidate(path, architecture, digest(config));
}
describe('OCI content-addressed release transport', () => {
  it('authorizes publication lookup in writer context while keeping public verification pull-only', async () => {
    const scopes: string[] = [];
    const request = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      if (url.pathname === '/token') { scopes.push(url.searchParams.get('scope') ?? ''); return new Response(JSON.stringify({ token: 'synthetic-bearer' })); }
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', request);
    const writer = new OciRegistry({ username: 'unit-actor', token: 'synthetic-token' });
    expect(await writer.manifest('dragoscirjan/redline-pi', '1.2.0')).toBeUndefined();
    expect(await new OciRegistry().manifest('dragoscirjan/redline-pi', '1.2.0')).toBeUndefined();
    expect(scopes).toEqual(['repository:dragoscirjan/redline-pi:pull,push', 'repository:dragoscirjan/redline-pi:pull']);
    expect(JSON.stringify(writer)).not.toContain('synthetic-token');
  });
  it('binds native execution configs, combines both platforms, uploads exact blobs and refuses tag changes', async () => {
    const amd = await archive('amd64'); const arm = await archive('arm64'); const index = combinePlatforms([arm, amd]);
    expect(JSON.parse(index.bytes.toString()).manifests.map((m: { platform: { architecture: string } }) => m.platform.architecture)).toEqual(['amd64', 'arm64']);
    await expect(inspectCandidate(amd.archive, 'arm64', amd.config.digest)).rejects.toThrow('platform');
    await expect(inspectCandidate(amd.archive, 'amd64', 'sha256:' + '0'.repeat(64))).rejects.toThrow('executed');
    const blobs = new Map<string, Buffer>(); const manifests = new Map<string, Buffer>(); const writes: string[] = [];
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://local'); const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part)); const bytes = Buffer.concat(parts);
      const reference = url.pathname.split('/').at(-1) ?? '';
      if (req.method === 'HEAD') { res.writeHead(blobs.has(reference) ? 200 : 404); res.end(); }
      else if (req.method === 'POST') { res.writeHead(202, { location: '/v2/dragoscirjan/redline-pi/blobs/uploads/fixture' }); res.end(); }
      else if (url.pathname.includes('/blobs/uploads/') && req.method === 'PUT') {
        if (digest(bytes) !== url.searchParams.get('digest')) { res.writeHead(400); res.end(); return; }
        blobs.set(digest(bytes), bytes); writes.push('blob'); res.writeHead(201, { 'docker-content-digest': digest(bytes) }); res.end();
      } else if (req.method === 'PUT') { manifests.set(reference, bytes); writes.push(reference); res.writeHead(201, { 'docker-content-digest': digest(bytes) }); res.end(); }
      else { const found = manifests.get(reference); if (found === undefined) { res.writeHead(404); res.end(); } else { res.writeHead(200, { 'docker-content-digest': digest(found) }); res.end(found); } }
    });
    const registry = new OciRegistry(undefined, await listen(server));
    await registry.publishCandidate('dragoscirjan/redline-pi', amd); await registry.publishCandidate('dragoscirjan/redline-pi', arm);
    await registry.publishManifest('dragoscirjan/redline-pi', '1.2.0', index.bytes, OCI_INDEX);
    const count = writes.length; await registry.publishManifest('dragoscirjan/redline-pi', '1.2.0', index.bytes, OCI_INDEX); expect(writes).toHaveLength(count);
    await expect(registry.publishManifest('dragoscirjan/redline-pi', '1.2.0', Buffer.from('{}'), OCI_INDEX)).rejects.toThrow('conflict');
    expect(writes).toHaveLength(count); expect((await registry.manifest('dragoscirjan/redline-pi', '1.2.0'))?.digest).toBe(index.digest);
    expect(blobs.get(amd.config.digest)?.length).toBe(amd.config.size);
  });
  it('rejects cross-origin blob-upload authority before sending any body', async () => {
    const candidate = await archive('amd64');
    const server = createServer((req, res) => { if (req.method === 'HEAD') res.writeHead(404); else res.writeHead(202, { location: 'http://127.0.0.1:9/exfiltrate' }); res.end(); });
    const registry = new OciRegistry(undefined, await listen(server));
    await expect(registry.uploadBlob('dragoscirjan/redline-pi', candidate, candidate.config)).rejects.toThrow('changed authority');
    await expect(registry.manifest('someone/else', '1.2.0')).rejects.toThrow('managed');
    await expect(registry.manifest('dragoscirjan/redline-pi', 'latest')).rejects.toThrow('immutable');
  });
});

describe('owned GitHub release transport', () => {
  async function fixture() {
    let release: Record<string, unknown> | undefined; const assets: Record<string, unknown>[] = []; let assetWrites = 0; let published = 0;
    let foreignAuthor = false; let conflictingTag = false;
    const origin = await listen(createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://local'); const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part)); const bytes = Buffer.concat(parts);
      const json = (value: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (url.pathname.includes('/git/ref/')) { if (conflictingTag) json({ object: { type: 'commit', sha: 'b'.repeat(40) } }); else { res.writeHead(404); res.end(); } }
      else if (url.pathname.endsWith('/assets') && req.method === 'POST') { assetWrites++; const asset = { id: assets.length + 1, name: url.searchParams.get('name'), size: bytes.length, digest: digest(bytes) }; assets.push(asset); json(asset); }
      else if (url.pathname.endsWith('/assets')) json(assets);
      else if (req.method === 'POST') { release = { ...JSON.parse(bytes.toString()), id: 1, author: { login: 'github-actions[bot]' } }; json(release); }
      else if (req.method === 'PATCH') { const update = JSON.parse(bytes.toString()); if (update.draft === false) published++; release = { ...release, ...update }; json(release); }
      else json(release === undefined ? [] : [{ ...release, author: { login: foreignAuthor ? 'unmanaged-human' : 'github-actions[bot]' } }]);
    }));
    return { github: new GitHubReleases('synthetic-github-token', origin), assets, writes: () => assetWrites, published: () => published,
      foreign: () => { foreignAuthor = true; }, conflict: () => { conflictingTag = true; } };
  }
  it('preserves the immutable marker, checkpoints uncertain npm writes and never republishes automatically', async () => {
    const f = await fixture(); const record = releaseFixture(); const first = await f.github.reserve(record);
    await f.github.markNpmAttempt(record); const after = await f.github.find(record.release);
    expect(after?.npmAttempted).toBe(true); if (after === undefined) throw new Error('Missing managed draft');
    expect(recordIdentity(after.record)).toBe(recordIdentity(first.record));
    await expect(f.github.markNpmAttempt(record)).rejects.toThrow('already attempted'); expect(f.published()).toBe(0);
  });
  it('uploads only declared byte-identical assets and requires all of them and the source tag before public release', async () => {
    const f = await fixture(); const record = releaseFixture();
    await expect(f.github.attach(record, record.npm.filename, Buffer.from('wrong'))).rejects.toThrow('immutable release identity');
    await expect(f.github.attach(record, 'unmanaged.txt', Buffer.from('no'))).rejects.toThrow('immutable release identity'); expect(f.writes()).toBe(0);
    await f.github.reserve(record); await expect(f.github.finalize(record)).rejects.toThrow('missing'); expect(f.published()).toBe(0);
    for (const asset of record.assets) await f.github.attach(record, asset.name, releaseAssetBytes(asset.name));
    await f.github.attach(record, 'release-manifest.json', Buffer.from(JSON.stringify(record, null, 2) + '\n'));
    const count = f.writes(); await f.github.attach(record, record.npm.filename, releaseAssetBytes(record.npm.filename)); expect(f.writes()).toBe(count);
    f.conflict(); await expect(f.github.finalize(record)).rejects.toThrow('source conflict'); expect(f.published()).toBe(0);
  });
  it('rejects an existing conflicting source tag before reserving or publishing anything', async () => {
    const f = await fixture(); const record = releaseFixture(); f.conflict();
    await expect(f.github.reserve(record)).rejects.toThrow('source conflict'); expect(f.writes()).toBe(0); expect(f.published()).toBe(0);
  });
  it('makes a complete matching draft public once, without replacing an attached asset', async () => {
    const f = await fixture(); const record = releaseFixture();
    for (const asset of record.assets) await f.github.attach(record, asset.name, releaseAssetBytes(asset.name));
    await f.github.attach(record, 'release-manifest.json', Buffer.from(JSON.stringify(record, null, 2) + '\n'));
    await f.github.finalize(record); await f.github.finalize(record);
    expect(f.published()).toBe(1); expect(f.writes()).toBe(record.assets.length + 1);
    const first = f.assets[0]; if (first === undefined) throw new Error('Missing fixture asset'); first.digest = 'sha256:' + '0'.repeat(64);
    await expect(f.github.attach(record, record.npm.filename, releaseAssetBytes(record.npm.filename))).rejects.toThrow('asset conflict');
  });
  it('selects original source artifacts on recovery instead of later successful rerun candidates', async () => {
    const record = releaseFixture(); let wrongSource = false;
    const origin = await listen(createServer((_req, res) => {
      const artifact = (id: number, arch: string, attempt: number) => ({ id, name: `worker-native-${arch}-123-attempt${attempt}`, expired: false,
        workflow_run: { head_sha: wrongSource ? 'b'.repeat(40) : record.source } });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ artifacts: [artifact(1, 'amd64', 1), artifact(2, 'amd64', 2), artifact(3, 'arm64', 1)] }));
    }));
    const github = new GitHubReleases('synthetic-token', origin);
    expect((await github.artifactSelection('123', record.source)).ids).toBe('2,3');
    expect((await github.artifactSelection('123', record.source, record.artifacts)).ids).toBe('1,3');
    wrongSource = true; await expect(github.artifactSelection('123', record.source, record.artifacts)).rejects.toThrow('different source');
  });
  it('fails closed on a marked release owned by the wrong actor without adding an asset', async () => {
    const f = await fixture(); const record = releaseFixture(); await f.github.reserve(record); f.foreign();
    await expect(f.github.attach(record, record.npm.filename, releaseAssetBytes(record.npm.filename))).rejects.toThrow('ownership'); expect(f.writes()).toBe(0);
  });
});

describe('bounded anonymous registry readiness', () => {
  it('uses fresh exact-version requests and distinguishes missing visibility from integrity conflicts', async () => {
    const queries: string[] = []; const record = releaseFixture(); let ready = false;
    const origin = await listen(createServer((req, res) => { const url = new URL(req.url ?? '/', 'http://local'); queries.push(url.search); expect(req.headers.authorization).toBeUndefined();
      if (!ready) { res.writeHead(404); res.end(); } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ name: record.package, version: record.release, dist: { integrity: record.npm.integrity } })); } }));
    expect(await npmIntegrity(record.release, origin)).toBeUndefined(); ready = true; expect(await npmIntegrity(record.release, origin)).toBe(record.npm.integrity);
    expect(new Set(queries).size).toBe(2);
    await waitForIdentity(() => npmIntegrity(record.release, origin), record.npm.integrity, 'npm', 5);
    await expect(waitForIdentity(async () => 'conflicting', record.npm.integrity, 'npm', 5)).rejects.toThrow('identity conflict');
    await expect(waitForIdentity(async () => undefined, record.npm.integrity, 'npm', 5)).rejects.toThrow('readiness budget');
  });
});
