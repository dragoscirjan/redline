import { createHash } from 'node:crypto';
import { parseReleaseRecord, type ReleaseRecord } from '../../src/release/coordinator.ts';
export function releaseAssetBytes(name: string): Buffer { return Buffer.from('Synthetic release asset: ' + name + '\n'); }
export function releaseFixture(): ReleaseRecord {
  const image = (h: 'pi' | 'opencode') => ({ repository: `dragoscirjan/redline-${h}` as const, digest: 'sha256:' + (h === 'pi' ? 'a' : 'b').repeat(64),
    harnessVersion: h === 'pi' ? '1.4.0' : '1.18.34', platforms: (['amd64', 'arm64'] as const).map(architecture => ({ architecture, manifest: 'sha256:' + 'c'.repeat(64), config: 'sha256:' + 'd'.repeat(64), archiveSha256: 'e'.repeat(64) })) });
  const filename = 'dragoscirjan-redline-1.2.0.tgz'; const bytes = releaseAssetBytes(filename);
  const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
  return parseReleaseRecord({ version: 1, package: '@dragoscirjan/redline', release: '1.2.0', source: 'a'.repeat(40), runId: '123',
    candidateArtifact: 'release-candidate-' + 'a'.repeat(40) + '-123-attempt1',
    artifacts: { amd64: 'worker-native-amd64-123-attempt1', arm64: 'worker-native-arm64-123-attempt1' },
    base: 'node:24.21.0-bookworm-slim@sha256:' + 'f'.repeat(64), npm: { filename, integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'), sha256: sha256(bytes) },
    images: { pi: image('pi'), opencode: image('opencode') }, assets: [filename, 'checksums.json', 'worker-sbom.spdx.json', 'build-provenance.json'].map(name => ({ name, sha256: sha256(releaseAssetBytes(name)), size: releaseAssetBytes(name).length })) });
}
