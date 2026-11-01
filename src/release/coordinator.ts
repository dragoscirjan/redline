import { createHash } from 'node:crypto';
import { isRecord as record } from '../process-runner.ts';
import { validDigest } from './oci.ts';

export const RELEASE_MARKER = 'redline-release/v1';
export interface ReleaseAsset { readonly name: string; readonly sha256: string; readonly size: number }
export interface ReleaseImage {
  readonly repository: 'dragoscirjan/redline-pi' | 'dragoscirjan/redline-opencode';
  readonly digest: string;
  readonly harnessVersion: string;
  readonly platforms: readonly { readonly architecture: 'amd64' | 'arm64'; readonly manifest: string; readonly config: string; readonly archiveSha256: string }[];
}
export interface ReleaseRecord {
  readonly version: 1;
  readonly package: '@dragoscirjan/redline';
  readonly release: string;
  readonly source: string;
  readonly runId: string;
  readonly candidateArtifact: string;
  readonly base: string;
  readonly artifacts: { readonly amd64: string; readonly arm64: string };
  readonly npm: { readonly filename: string; readonly integrity: string; readonly sha256: string };
  readonly images: { readonly pi: ReleaseImage; readonly opencode: ReleaseImage };
  readonly assets: readonly ReleaseAsset[];
}
const hash = (value: string) => /^[a-f0-9]{64}$/u.test(value);
function exactly(value: Record<string, unknown>, names: readonly string[]): boolean {
  return names.length === Object.keys(value).length && names.every(name => Object.hasOwn(value, name));
}
export function parseReleaseRecord(value: unknown): ReleaseRecord {
  if (!record(value) || !exactly(value, ['version', 'package', 'release', 'source', 'runId', 'candidateArtifact', 'base', 'artifacts', 'npm', 'images', 'assets'])
    || value.version !== 1 || value.package !== '@dragoscirjan/redline' || typeof value.release !== 'string'
    || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/u.test(value.release) || value.release.length > 128
    || typeof value.source !== 'string' || !/^[a-f0-9]{40}$/u.test(value.source) || typeof value.runId !== 'string' || !/^[0-9]{1,32}$/u.test(value.runId)
    || typeof value.base !== 'string' || !/^node:[A-Za-z0-9.-]+@sha256:[a-f0-9]{64}$/u.test(value.base)
    || !record(value.npm) || !exactly(value.npm, ['filename', 'integrity', 'sha256'])
    || value.npm.filename !== `dragoscirjan-redline-${value.release}.tgz` || typeof value.npm.sha256 !== 'string' || !hash(value.npm.sha256)
    || typeof value.npm.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(value.npm.integrity)
    || !record(value.images) || !exactly(value.images, ['pi', 'opencode']) || !Array.isArray(value.assets) || value.assets.length > 16) throw new Error('Invalid immutable release record');
  if (typeof value.candidateArtifact !== 'string' || value.candidateArtifact.length > 180
    || !new RegExp(`^release-candidate-${value.source}-${value.runId}-attempt[0-9]+$`, 'u').test(value.candidateArtifact)) throw new Error('Invalid original npm candidate artifact identity');
  const artifacts = value.artifacts;
  if (!record(artifacts) || !exactly(artifacts, ['amd64', 'arm64'])
    || !(['amd64', 'arm64'] as const).every(arch => typeof artifacts[arch] === 'string'
      && new RegExp(`^worker-native-${arch}-${value.runId}-attempt[0-9]+$`, 'u').test(String(artifacts[arch])))) throw new Error('Invalid original native artifact identities');
  const image = (v: unknown, harness: 'pi' | 'opencode'): v is ReleaseImage => {
    if (!record(v) || !exactly(v, ['repository', 'digest', 'harnessVersion', 'platforms']) || v.repository !== 'dragoscirjan/redline-' + harness
      || !validDigest(v.digest) || typeof v.harnessVersion !== 'string' || !v.harnessVersion.length || v.harnessVersion.length > 64
      || !Array.isArray(v.platforms) || v.platforms.length !== 2) return false;
    const architectures = new Set<string>();
    for (const p of v.platforms) {
      if (!record(p) || !exactly(p, ['architecture', 'manifest', 'config', 'archiveSha256']) || (p.architecture !== 'amd64' && p.architecture !== 'arm64')
        || !validDigest(p.manifest) || !validDigest(p.config) || typeof p.archiveSha256 !== 'string' || !hash(p.archiveSha256)) return false;
      architectures.add(p.architecture);
    }
    return architectures.size === 2;
  };
  const pi = value.images.pi; const opencode = value.images.opencode;
  if (!image(pi, 'pi') || !image(opencode, 'opencode')) throw new Error('Invalid release image identities');
  const npm = value.npm;
  const assets: ReleaseAsset[] = [];
  for (const a of value.assets) {
    if (!record(a) || !exactly(a, ['name', 'sha256', 'size']) || typeof a.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/u.test(a.name)
      || typeof a.sha256 !== 'string' || !hash(a.sha256) || typeof a.size !== 'number' || !Number.isSafeInteger(a.size) || a.size < 1 || a.size > 32 * 1024 * 1024) throw new Error('Invalid release asset');
    assets.push({ name: a.name, sha256: a.sha256, size: a.size });
  }
  if (new Set(assets.map(a => a.name)).size !== assets.length || !assets.some(a => a.name === npm.filename && a.sha256 === npm.sha256)
    || !['checksums.json', 'worker-sbom.spdx.json', 'build-provenance.json'].every(name => assets.some(a => a.name === name))) throw new Error('Release asset identities conflict');
  return { version: 1, package: '@dragoscirjan/redline', release: value.release, source: value.source, runId: value.runId, candidateArtifact: value.candidateArtifact, base: value.base,
    artifacts: { amd64: String(artifacts.amd64), arm64: String(artifacts.arm64) },
    npm: { filename: value.npm.filename, integrity: value.npm.integrity, sha256: value.npm.sha256 }, images: { pi, opencode }, assets };
}
export function releaseTag(release: string): string { return '@dragoscirjan/redline@' + release; }
export function releaseBody(value: ReleaseRecord, complete = false): string {
  const record = parseReleaseRecord(value);
  const marker = Buffer.from(JSON.stringify(record)).toString('base64url');
  return `<!-- ${RELEASE_MARKER}:${marker} -->\n# Redline ${record.release}\n\n${complete ? 'All required artifacts and native anonymous checks passed.' : 'Draft. Publication or public verification is incomplete.'}\n\n`
    + `npm: [${record.package}@${record.release}](https://www.npmjs.com/package/${record.package}/v/${record.release})\n\n`
    + ['pi', 'opencode'].map(h => {
      const image = h === 'pi' ? record.images.pi : record.images.opencode;
      return `- ${h}: \`ghcr.io/${image.repository}@${image.digest}\`\n`;
    }).join('') + `\nSource: \`${record.source}\`. See the attached manifest, npm tarball, checksums, SBOM and provenance.\n`;
}
export function recordFromBody(body: string): ReleaseRecord {
  if (body.length > 128 * 1024) throw new Error('Managed release body exceeds limit');
  const matches = [...body.matchAll(/<!-- redline-release\/v1:([A-Za-z0-9_-]+) -->/gu)];
  if (matches.length !== 1) throw new Error('Release marker is missing or ambiguous');
  const encoded = matches[0]?.[1]; if (encoded === undefined) throw new Error('Invalid release marker');
  const bytes = Buffer.from(encoded, 'base64url'); if (bytes.toString('base64url') !== encoded) throw new Error('Invalid release marker');
  return parseReleaseRecord(JSON.parse(bytes.toString('utf8')));
}
export function recordIdentity(record: ReleaseRecord): string {
  return createHash('sha256').update(JSON.stringify(parseReleaseRecord(record))).digest('hex');
}
export interface ReleasePorts {
  reserve(record: ReleaseRecord): Promise<void>;
  npmIntegrity(version: string): Promise<string | undefined>;
  publishNpm(record: ReleaseRecord): Promise<void>;
  imageDigest(repository: string, version: string): Promise<string | undefined>;
  publishImage(image: ReleaseImage, version: string): Promise<void>;
  verifyPublic(record: ReleaseRecord): Promise<void>;
  finalize(record: ReleaseRecord): Promise<void>;
}
/** Every external write is preceded by immutable identity checks. Ports own bounded visibility waits. */
export async function coordinateRelease(input: ReleaseRecord, ports: ReleasePorts, finalize = false): Promise<void> {
  const record = parseReleaseRecord(input);
  await ports.reserve(record);
  const npm = await ports.npmIntegrity(record.release);
  if (npm !== undefined && npm !== record.npm.integrity) throw new Error('Immutable npm version conflict');
  const current = new Map<string, string | undefined>();
  for (const image of [record.images.pi, record.images.opencode]) {
    const actual = await ports.imageDigest(image.repository, record.release); current.set(image.repository, actual);
    if (actual !== undefined && actual !== image.digest) throw new Error('Immutable image version conflict');
  }
  if (npm === undefined) await ports.publishNpm(record);
  for (const image of [record.images.pi, record.images.opencode]) {
    if (current.get(image.repository) === undefined) await ports.publishImage(image, record.release);
  }
  await ports.verifyPublic(record);
  if (finalize) await ports.finalize(record);
}
