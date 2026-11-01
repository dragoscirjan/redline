import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { responseBytes } from './http.ts';
import { record } from '../harness-worker/contract.ts';

const exec = promisify(execFile);
export const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
export const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
export interface Descriptor { readonly mediaType: string; readonly digest: string; readonly size: number }
export interface PlatformDescriptor extends Descriptor { readonly platform: { readonly os: 'linux'; readonly architecture: 'amd64' | 'arm64' } }
export interface OciCandidate {
  readonly archive: string;
  readonly descriptor: PlatformDescriptor;
  readonly config: Descriptor;
  readonly layers: readonly Descriptor[];
  readonly manifest: Buffer;
}
export function digest(bytes: Uint8Array): string { return 'sha256:' + createHash('sha256').update(bytes).digest('hex'); }
export function validDigest(value: unknown): value is string { return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value); }
function descriptor(value: unknown): value is Descriptor {
  return record(value) && typeof value.mediaType === 'string' && validDigest(value.digest)
    && typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 0 && value.size <= 2 * 1024 * 1024 * 1024;
}
export async function archiveJson(archive: string, path: string): Promise<{ bytes: Buffer; value: unknown }> {
  if (path !== 'index.json' && !/^blobs\/sha256\/[a-f0-9]{64}$/u.test(path)) throw new Error('Invalid OCI member');
  const result = await exec('tar', ['-xOf', archive, path], { encoding: 'buffer', env: { PATH: process.env.PATH, LANG: 'C' }, maxBuffer: 1024 * 1024, timeout: 30_000 });
  const bytes = result.stdout;
  return { bytes, value: JSON.parse(bytes.toString('utf8')) };
}
export async function inspectCandidate(archive: string, architecture: 'amd64' | 'arm64', expectedConfig: string): Promise<OciCandidate> {
  const { value: index } = await archiveJson(archive, 'index.json');
  if (!record(index) || index.schemaVersion !== 2 || index.mediaType !== OCI_INDEX || !Array.isArray(index.manifests) || index.manifests.length !== 1) throw new Error('Invalid native OCI index');
  const item = index.manifests[0];
  if (!descriptor(item) || item.mediaType !== OCI_MANIFEST || !record(item) || !record(item.platform)
    || item.platform.os !== 'linux' || item.platform.architecture !== architecture) throw new Error('OCI platform mismatch');
  const { value: manifest, bytes } = await archiveJson(archive, 'blobs/sha256/' + item.digest.slice(7));
  if (digest(bytes) !== item.digest || bytes.length !== item.size || !record(manifest) || manifest.schemaVersion !== 2 || manifest.mediaType !== OCI_MANIFEST
    || !descriptor(manifest.config) || manifest.config.digest !== expectedConfig || !Array.isArray(manifest.layers) || manifest.layers.length > 128
    || !manifest.layers.every(descriptor)) throw new Error('OCI content does not match the executed native image');
  const config = await archiveJson(archive, 'blobs/sha256/' + manifest.config.digest.slice(7));
  if (digest(config.bytes) !== expectedConfig || config.bytes.length !== manifest.config.size || !record(config.value)
    || config.value.os !== 'linux' || config.value.architecture !== architecture) throw new Error('OCI config mismatch');
  return { archive, descriptor: { mediaType: OCI_MANIFEST, digest: item.digest, size: item.size, platform: { os: 'linux', architecture } },
    config: manifest.config, layers: manifest.layers, manifest: bytes };
}
export function combinePlatforms(candidates: readonly OciCandidate[]): { bytes: Buffer; digest: string } {
  if (candidates.length !== 2 || candidates.some(c => c.descriptor.platform.os !== 'linux')
    || new Set(candidates.map(c => c.descriptor.platform.architecture)).size !== 2) throw new Error('Both native platform candidates are required');
  const manifests = candidates.map(c => c.descriptor).sort((a, b) => a.platform.architecture.localeCompare(b.platform.architecture));
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: OCI_INDEX, manifests }));
  return { bytes, digest: digest(bytes) };
}

interface RegistryCredentials { readonly username: string; readonly token: string }
/** Only the release controller constructs this client. A worker never receives registry authority. */
export class OciRegistry {
  readonly #origin: URL;
  readonly #credentials: RegistryCredentials | undefined;
  readonly #tokens = new Map<string, string>();
  constructor(credentials?: RegistryCredentials, origin = 'https://ghcr.io') {
    this.#origin = new URL(origin); this.#credentials = credentials;
    if (origin !== 'https://ghcr.io' && !(this.#origin.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(this.#origin.hostname))) throw new Error('Invalid registry origin');
  }
  private repository(repository: string): void {
    if (!/^dragoscirjan\/redline-(?:pi|opencode)$/u.test(repository)) throw new Error('Invalid managed registry package');
  }
  private async headers(repository: string, write: boolean): Promise<Record<string, string>> {
    this.repository(repository);
    if (this.#origin.protocol === 'http:') return {};
    const scope = `repository:${repository}:${write ? 'pull,push' : 'pull'}`;
    let token = this.#tokens.get(scope);
    if (token === undefined) {
      const url = new URL('/token', this.#origin); url.searchParams.set('service', 'ghcr.io'); url.searchParams.set('scope', scope);
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000), headers: this.#credentials === undefined ? {}
        : { authorization: 'Basic ' + Buffer.from(this.#credentials.username + ':' + this.#credentials.token).toString('base64') } });
      if (!response.ok) throw new Error('Registry authorization unavailable');
      const data: unknown = JSON.parse((await responseBytes(response, 64 * 1024)).toString('utf8'));
      if (!record(data) || typeof data.token !== 'string' || data.token.length > 32 * 1024) throw new Error('Invalid registry authorization');
      token = data.token; this.#tokens.set(scope, token);
    }
    return { authorization: 'Bearer ' + token };
  }
  async manifest(repository: string, reference: string): Promise<{ digest: string; bytes: Buffer } | undefined> {
    this.repository(repository);
    if (!validDigest(reference) && !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/u.test(reference)) throw new Error('Invalid immutable registry reference');
    const response = await fetch(new URL(`/v2/${repository}/manifests/${reference}`, this.#origin), {
      headers: { ...await this.headers(repository, false), accept: OCI_INDEX + ', ' + OCI_MANIFEST }, redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error('Registry manifest lookup failed');
    const bytes = await responseBytes(response, 1024 * 1024);
    if (bytes.length > 1024 * 1024) throw new Error('Registry manifest exceeds limit');
    const actual = digest(bytes);
    if (response.headers.get('docker-content-digest') !== actual) throw new Error('Registry manifest integrity mismatch');
    return { bytes, digest: actual };
  }
  async publishManifest(repository: string, reference: string, bytes: Buffer, mediaType: string): Promise<void> {
    this.repository(repository);
    if (!validDigest(reference) && !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/u.test(reference)) throw new Error('Invalid immutable registry reference');
    const current = await this.manifest(repository, reference);
    if (current !== undefined) {
      if (current.digest !== digest(bytes)) throw new Error('Immutable registry reference conflict');
      return;
    }
    const response = await fetch(new URL(`/v2/${repository}/manifests/${reference}`, this.#origin), {
      method: 'PUT', headers: { ...await this.headers(repository, true), 'content-type': mediaType }, body: new Uint8Array(bytes),
      redirect: 'error', signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok || response.headers.get('docker-content-digest') !== digest(bytes)) throw new Error('Registry manifest publication failed');
  }
  async uploadBlob(repository: string, candidate: OciCandidate, blob: Descriptor): Promise<void> {
    this.repository(repository);
    const headers = await this.headers(repository, true);
    const existing = await fetch(new URL(`/v2/${repository}/blobs/${blob.digest}`, this.#origin), { method: 'HEAD', headers, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    if (existing.status === 200 || existing.status === 307) return;
    if (existing.status !== 404) throw new Error('Registry blob lookup failed');
    const start = await fetch(new URL(`/v2/${repository}/blobs/uploads/`, this.#origin), { method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    const location = start.headers.get('location');
    if (start.status !== 202 || location === null) throw new Error('Registry upload initialization failed');
    const upload = new URL(location, this.#origin);
    if (upload.origin !== this.#origin.origin || !upload.pathname.startsWith(`/v2/${repository}/blobs/uploads/`)) throw new Error('Registry upload changed authority');
    upload.searchParams.set('digest', blob.digest);
    const child = spawn('tar', ['-xOf', candidate.archive, 'blobs/sha256/' + blob.digest.slice(7)], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, LANG: 'C' } });
    child.stderr.on('data', () => undefined);
    const exit = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    void exit.catch(() => undefined);
    try {
      const init: RequestInit & { duplex: 'half' } = { method: 'PUT', headers: { ...headers, 'content-length': String(blob.size), 'content-type': 'application/octet-stream' },
        // Node's native WHATWG stream has divergent Node/DOM declaration overloads.
        body: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>, duplex: 'half', redirect: 'error', signal: AbortSignal.timeout(120_000) };
      const response = await fetch(upload, init);
      if (!response.ok || response.headers.get('docker-content-digest') !== blob.digest || await exit !== 0) throw new Error('Registry blob publication failed');
    } finally { child.kill('SIGKILL'); }
  }
  async publishCandidate(repository: string, candidate: OciCandidate): Promise<void> {
    for (const blob of [candidate.config, ...candidate.layers]) await this.uploadBlob(repository, candidate, blob);
    await this.publishManifest(repository, candidate.descriptor.digest, candidate.manifest, OCI_MANIFEST);
  }
}
