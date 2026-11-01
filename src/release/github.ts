import { createHash } from 'node:crypto';
import { responseBytes } from './http.ts';
import { record } from '../harness-worker/contract.ts';
import { recordFromBody, recordIdentity, releaseBody, releaseTag, type ReleaseRecord } from './coordinator.ts';

export interface ManagedRelease { readonly id: number; readonly draft: boolean; readonly record: ReleaseRecord; readonly npmAttempted: boolean }
const repo = '/repos/dragoscirjan/redline';

function identifier(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
export class GitHubReleases {
  readonly #token: string;
  readonly #origin: URL;
  constructor(token: string, origin = 'https://api.github.com') {
    this.#token = token; this.#origin = new URL(origin);
    if (origin !== 'https://api.github.com' && !(this.#origin.protocol === 'http:' && this.#origin.hostname === '127.0.0.1')) throw new Error('Invalid release API origin');
  }
  private async request(path: string, method = 'GET', body?: unknown): Promise<unknown | undefined> {
    if (!path.startsWith(repo + '/')) throw new Error('Release API path changed authority');
    const response = await fetch(new URL(path, this.#origin), { method, redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: { authorization: 'Bearer ' + this.#token, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.status === 404 && method === 'GET') return undefined;
    if (!response.ok) throw new Error('GitHub release API operation failed');
    const bytes = await responseBytes(response, 2 * 1024 * 1024);
    return bytes.length === 0 ? undefined : JSON.parse(bytes.toString('utf8'));
  }
  private managed(value: unknown, expectedRelease: string): ManagedRelease {
    if (!record(value) || !identifier(value.id) || value.tag_name !== releaseTag(expectedRelease) || typeof value.body !== 'string'
      || typeof value.draft !== 'boolean' || !record(value.author) || value.author.login !== 'github-actions[bot]') throw new Error('Release ownership mismatch');
    const manifest = recordFromBody(value.body);
    if (manifest.release !== expectedRelease) throw new Error('Release version mismatch');
    const markers = [...value.body.matchAll(/<!-- redline-release-progress\/v1:(true|false) -->/gu)];
    if (markers.length !== 1) throw new Error('Ambiguous release progress');
    return { id: value.id, draft: value.draft, record: manifest, npmAttempted: markers[0]?.[1] === 'true' };
  }
  async artifactSelection(runId: string, source: string, expected?: { readonly amd64: string; readonly arm64: string }): Promise<{ ids: string; names: { amd64: string; arm64: string } }> {
    if (!/^[0-9]{1,32}$/u.test(runId) || !/^[a-f0-9]{40}$/u.test(source)) throw new Error('Invalid source artifact run');
    const candidates: Record<'amd64' | 'arm64', { id: number; name: string; attempt: number }[]> = { amd64: [], arm64: [] };
    for (let page = 1; page <= 5; page++) {
      const values = await this.request(`${repo}/actions/runs/${runId}/artifacts?per_page=100&page=${page}`);
      if (!record(values) || !Array.isArray(values.artifacts)) throw new Error('Invalid source artifact list');
      for (const artifact of values.artifacts) {
        if (!record(artifact) || typeof artifact.name !== 'string') continue;
        for (const arch of ['amd64', 'arm64'] as const) {
          const match = new RegExp(`^worker-native-${arch}-${runId}-attempt([0-9]+)$`, 'u').exec(artifact.name);
          if (match === null || (expected !== undefined && artifact.name !== expected[arch])) continue;
          if (!identifier(artifact.id) || artifact.expired !== false || !record(artifact.workflow_run) || artifact.workflow_run.head_sha !== source) throw new Error('Original artifact is expired or belongs to a different source');
          candidates[arch].push({ id: artifact.id, name: artifact.name, attempt: Number(match[1]) });
        }
      }
      if (values.artifacts.length < 100) break;
      if (page === 5) throw new Error('Source artifact discovery limit exceeded');
    }
    const selected = (arch: 'amd64' | 'arm64') => {
      const values = candidates[arch].sort((a, b) => b.attempt - a.attempt); const item = values[0];
      if (item === undefined || (expected !== undefined && values.length !== 1) || (values[1]?.attempt === item.attempt)) throw new Error('Required original native artifact is missing or ambiguous');
      return item;
    };
    const amd64 = selected('amd64'); const arm64 = selected('arm64');
    return { ids: `${amd64.id},${arm64.id}`, names: { amd64: amd64.name, arm64: arm64.name } };
  }
  async candidateArtifactId(manifest: ReleaseRecord): Promise<number> {
    const values = await this.request(`${repo}/actions/runs/${manifest.runId}/artifacts?per_page=100&name=${encodeURIComponent(manifest.candidateArtifact)}`);
    if (!record(values) || !Array.isArray(values.artifacts) || values.artifacts.length !== 1) throw new Error('Original npm candidate artifact is missing or ambiguous');
    const artifact = values.artifacts[0];
    if (!record(artifact) || artifact.name !== manifest.candidateArtifact || !identifier(artifact.id) || artifact.expired !== false || !record(artifact.workflow_run) || artifact.workflow_run.head_sha !== manifest.source) throw new Error('Original npm candidate artifact identity mismatch');
    return artifact.id;
  }
  async find(release: string): Promise<ManagedRelease | undefined> {
    let found: ManagedRelease | undefined;
    for (let page = 1; page <= 10; page++) {
      const values = await this.request(`${repo}/releases?per_page=100&page=${page}`);
      if (!Array.isArray(values)) throw new Error('Invalid release list');
      for (const value of values) if (record(value) && value.tag_name === releaseTag(release)) {
        if (found !== undefined) throw new Error('Ambiguous managed release');
        found = this.managed(value, release);
      }
      if (values.length < 100) return found;
    }
    throw new Error('Release discovery limit exceeded');
  }
  async reserve(manifest: ReleaseRecord): Promise<ManagedRelease> {
    const existing = await this.find(manifest.release);
    if (existing !== undefined) {
      if (recordIdentity(existing.record) !== recordIdentity(manifest)) throw new Error('Immutable release identity conflict');
      return existing;
    }
    const value = await this.request(repo + '/releases', 'POST', { tag_name: releaseTag(manifest.release), target_commitish: manifest.source,
      name: 'Redline ' + manifest.release, body: releaseBody(manifest) + '\n<!-- redline-release-progress/v1:false -->\n', draft: true,
      prerelease: manifest.release.includes('-') });
    return this.managed(value, manifest.release);
  }
  async markNpmAttempt(manifest: ReleaseRecord): Promise<void> {
    const release = await this.reserve(manifest);
    if (!release.draft) throw new Error('Cannot change publication progress on a public release');
    if (release.npmAttempted) throw new Error('npm publication was already attempted; await registry visibility or investigate before any retry');
    await this.request(`${repo}/releases/${release.id}`, 'PATCH', { body: releaseBody(manifest) + '\n<!-- redline-release-progress/v1:true -->\n' });
  }
  private async assets(id: number): Promise<Record<string, unknown>[]> {
    const output: Record<string, unknown>[] = [];
    for (let page = 1; page <= 4; page++) {
      const values = await this.request(`${repo}/releases/${id}/assets?per_page=100&page=${page}`);
      if (!Array.isArray(values) || !values.every(record)) throw new Error('Invalid release asset list');
      output.push(...values);
      if (values.length < 100) return output;
    }
    throw new Error('Release asset discovery limit exceeded');
  }
  async attach(manifest: ReleaseRecord, name: string, bytes: Buffer): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/u.test(name) || bytes.length > 32 * 1024 * 1024) throw new Error('Invalid managed release asset');
    const canonical = name === 'release-manifest.json' ? Buffer.from(JSON.stringify(manifest, null, 2) + '\n') : undefined;
    const declared = manifest.assets.find(a => a.name === name);
    const checksum = createHash('sha256').update(bytes).digest('hex');
    if (canonical === undefined ? declared === undefined || declared.size !== bytes.length || declared.sha256 !== checksum : !canonical.equals(bytes)) throw new Error('Asset is not part of the immutable release identity');
    const release = await this.reserve(manifest);
    const existing = (await this.assets(release.id)).filter(asset => asset.name === name);
    if (existing.length > 1) throw new Error('Ambiguous managed release asset');
    const expected = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
    if (existing.length === 1) {
      const asset = existing[0];
      if (!asset || asset.size !== bytes.length || asset.digest !== expected) throw new Error('Immutable release asset conflict');
      return;
    }
    if (!release.draft) throw new Error('Cannot add an unverified asset to a public release');
    const origin = this.#origin.hostname === 'api.github.com' ? new URL('https://uploads.github.com') : this.#origin;
    const url = new URL(`${repo}/releases/${release.id}/assets`, origin); url.searchParams.set('name', name);
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000),
      headers: { authorization: 'Bearer ' + this.#token, 'content-type': 'application/octet-stream', accept: 'application/vnd.github+json' }, body: new Uint8Array(bytes) });
    if (!response.ok) throw new Error('Release asset upload failed');
    const value: unknown = JSON.parse((await responseBytes(response, 1024 * 1024)).toString('utf8'));
    if (!record(value) || value.name !== name || value.size !== bytes.length || value.digest !== expected) throw new Error('Uploaded release asset integrity mismatch');
  }
  async finalize(manifest: ReleaseRecord): Promise<void> {
    const release = await this.reserve(manifest);
    const available = await this.assets(release.id);
    for (const asset of manifest.assets) {
      if (available.filter(v => v.name === asset.name && v.size === asset.size && v.digest === 'sha256:' + asset.sha256).length !== 1) throw new Error('Required release asset is missing or conflicting');
    }
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    const manifestDigest = 'sha256:' + createHash('sha256').update(manifestBytes).digest('hex');
    if (available.filter(v => v.name === 'release-manifest.json' && v.digest === manifestDigest).length !== 1) throw new Error('Immutable release manifest asset is missing');
    const ref = await this.request(`${repo}/git/ref/tags/${encodeURIComponent(releaseTag(manifest.release))}`);
    if (ref !== undefined) {
      if (!record(ref) || !record(ref.object)) throw new Error('Invalid release tag reference');
      let object = ref.object;
      for (let depth = 0; object.type === 'tag' && depth < 4; depth++) {
        if (typeof object.sha !== 'string' || !/^[a-f0-9]{40}$/u.test(object.sha)) throw new Error('Invalid annotated tag');
        const tag = await this.request(`${repo}/git/tags/${object.sha}`);
        if (!record(tag) || !record(tag.object)) throw new Error('Invalid annotated tag'); object = tag.object;
      }
      if (object.type !== 'commit' || object.sha !== manifest.source) throw new Error('Immutable release tag source conflict');
    }
    if (release.draft) await this.request(`${repo}/releases/${release.id}`, 'PATCH', { draft: false, body: releaseBody(manifest, true) + '\n<!-- redline-release-progress/v1:true -->\n' });
  }
}
