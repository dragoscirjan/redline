import { describe, expect, it } from 'vitest';
import { coordinateRelease, parseReleaseRecord, recordFromBody, recordIdentity, releaseBody, type ReleaseRecord, type ReleasePorts } from '../src/release/coordinator.ts';

import { releaseFixture as fixture } from './helpers/release.ts';
function ports(manifest: ReleaseRecord, mask = 0) {
  const calls: string[] = []; const images = new Map<string, string>(); let npm: string | undefined = (mask & 1) ? manifest.npm.integrity : undefined;
  if (mask & 2) images.set(manifest.images.pi.repository, manifest.images.pi.digest);
  if (mask & 4) images.set(manifest.images.opencode.repository, manifest.images.opencode.digest);
  let identity: string | undefined;
  const result: ReleasePorts = {
    async reserve(record) { calls.push('reserve'); if (identity !== undefined && identity !== recordIdentity(record)) throw new Error('Immutable release identity conflict'); identity = recordIdentity(record); },
    async npmIntegrity() { return npm; }, async publishNpm(record) { calls.push('npm'); npm = record.npm.integrity; },
    async imageDigest(repository) { return images.get(repository); },
    async publishImage(image) { calls.push(image.repository); images.set(image.repository, image.digest); },
    async verifyPublic(record) { calls.push('verify'); if (npm !== record.npm.integrity || images.get(record.images.pi.repository) !== record.images.pi.digest || images.get(record.images.opencode.repository) !== record.images.opencode.digest) throw new Error('Public verification failed'); },
    async finalize() { calls.push('finalize'); },
  };
  return { result, calls, images, npm: (value: string) => { npm = value; } };
}
describe('coordinated immutable publication', () => {
  for (let mask = 0; mask < 8; mask++) it(`publishes only missing artifacts for partial state ${mask}, then verifies even a complete no-op`, async () => {
    const record = fixture(); const f = ports(record, mask);
    await coordinateRelease(record, f.result);
    expect(f.calls.includes('npm')).toBe(!(mask & 1));
    expect(f.calls.includes(record.images.pi.repository)).toBe(!(mask & 2));
    expect(f.calls.includes(record.images.opencode.repository)).toBe(!(mask & 4));
    expect(f.calls.at(-1)).toBe('verify'); expect(f.calls).not.toContain('finalize');
    const previousWrites = f.calls.filter(c => c !== 'reserve' && c !== 'verify').length;
    await coordinateRelease(record, f.result, true);
    expect(f.calls.at(-2)).toBe('verify'); expect(f.calls.at(-1)).toBe('finalize');
    expect(f.calls.filter(c => !['reserve', 'verify', 'finalize'].includes(c))).toHaveLength(previousWrites);
  });
  it('detects every immutable version conflict before any artifact write', async () => {
    const record = fixture();
    for (const field of ['npm', 'pi', 'opencode'] as const) {
      const f = ports(record);
      if (field === 'npm') f.npm('sha512-conflict'); else f.images.set(record.images[field].repository, 'sha256:' + '0'.repeat(64));
      await expect(coordinateRelease(record, f.result)).rejects.toThrow(/conflict/u); expect(f.calls).toEqual(['reserve']);
    }
  });
  it('locks a draft to its validated source and candidates instead of a later main commit with the same version', async () => {
    const record = fixture(); const f = ports(record);
    await coordinateRelease(record, f.result);
    await expect(coordinateRelease({ ...record, source: 'b'.repeat(40), candidateArtifact: 'release-candidate-' + 'b'.repeat(40) + '-123-attempt1' }, f.result)).rejects.toThrow('identity conflict');
    expect(f.calls.filter(c => c === 'npm')).toHaveLength(1);
  });
  it('leaves a partial release unpublished and recovers without republishing npm', async () => {
    const record = fixture(); const f = ports(record); const original = f.result.publishImage; let once = true;
    f.result.publishImage = async (image, version) => { if (once) { once = false; throw new Error('Image unavailable'); } await original(image, version); };
    await expect(coordinateRelease(record, f.result, true)).rejects.toThrow('Image unavailable'); expect(f.calls).not.toContain('finalize');
    await coordinateRelease(record, f.result, true);
    expect(f.calls.filter(c => c === 'npm')).toHaveLength(1); expect(f.calls.at(-1)).toBe('finalize');
  });
  it('never calls finalization after public verification fails', async () => {
    const record = fixture(); const f = ports(record, 7); f.result.verifyPublic = async () => { throw new Error('Anonymous install unavailable'); };
    await expect(coordinateRelease(record, f.result, true)).rejects.toThrow('Anonymous install unavailable'); expect(f.calls).not.toContain('finalize');
  });
  it('round trips an immutable marker and rejects ambiguous, malformed or incomplete identities', () => {
    const record = fixture(); const body = releaseBody(record); expect(recordFromBody(body)).toEqual(record);
    expect(() => recordFromBody(body + body)).toThrow('ambiguous');
    expect(() => parseReleaseRecord({ ...record, extra: 'ignored?' })).toThrow();
    expect(() => parseReleaseRecord({ ...record, assets: [] })).toThrow();
    expect(() => parseReleaseRecord({ ...record, images: { ...record.images, pi: { ...record.images.pi, platforms: [record.images.pi.platforms[0], record.images.pi.platforms[0]] } } })).toThrow();
    expect(() => parseReleaseRecord({ ...record, release: '1.2.0+mutable' })).toThrow();
  });
});
