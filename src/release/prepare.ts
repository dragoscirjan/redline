import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileDigest } from '../harness-worker/build.ts';
import { record } from '../harness-worker/contract.ts';
import { parseWorkerManifest } from '../harness-worker/images.ts';
import { parseReleaseRecord, type ReleaseRecord, type ReleaseImage } from './coordinator.ts';
import { combinePlatforms, inspectCandidate, type OciCandidate } from './oci.ts';
import { assertPublishOnlyChangesets } from './npm-check.ts';
import { verifyOfflineCandidate } from './candidate-smoke.ts';
import { packCandidate } from './npm-registry.ts';
const exec = promisify(execFile);
export interface ReleaseIntent {
  readonly release: string; readonly source: string; readonly runId: string; readonly candidateArtifact: string;
  readonly artifacts: { readonly amd64: string; readonly arm64: string };
}
export async function fileBytes(path: string, cap = 32 * 1024 * 1024): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat(); if (!info.isFile() || info.size > cap) throw new Error('Invalid release input file');
    const bytes = await handle.readFile(); if (bytes.length > cap) throw new Error('Release input grew beyond its bound'); return bytes;
  } finally { await handle.close(); }
}
export async function jsonFile(path: string, cap = 2 * 1024 * 1024): Promise<unknown> {
  return JSON.parse((await fileBytes(path, cap)).toString('utf8'));
}
export async function verifyAttestation(path: string, source: string, signer: 'ci.yml' | 'npm.release.yml', token: string): Promise<unknown> {
  const home = await mkdtemp(join(tmpdir(), 'redline-attestation-'));
  try {
    const result = await exec('gh', ['attestation', 'verify', path, '--repo', 'dragoscirjan/redline', '--source-ref', 'refs/heads/main', '--source-digest', source,
      '--signer-workflow', 'dragoscirjan/redline/.github/workflows/' + signer, '--signer-digest', source, '--format', 'json'],
    { env: { PATH: process.env.PATH, HOME: home, GH_CONFIG_DIR: join(home, 'gh'), GH_TOKEN: token, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    const value: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(value) || value.length === 0) throw new Error('No verified provenance'); return value;
  } catch { throw new Error('Original trusted-main artifact provenance verification failed'); }
  finally { await rm(home, { recursive: true, force: true }); }
}
export interface NativeInputs { readonly candidates: Record<'pi' | 'opencode', OciCandidate[]>; readonly inventories: unknown[]; readonly provenance: unknown[]; readonly base: string; readonly pins: Record<string, unknown> }
export async function nativeInputs(root: string, intent: ReleaseIntent, token: string): Promise<NativeInputs> {
  const candidates: NativeInputs['candidates'] = { pi: [], opencode: [] }; const inventories: unknown[] = []; const provenance: unknown[] = [];
  let base: string | undefined; let commonPins: string | undefined; let pins: Record<string, unknown> | undefined;
  for (const arch of ['amd64', 'arm64'] as const) {
    const artifact = intent.artifacts[arch];
    if (!new RegExp(`^worker-native-${arch}-${intent.runId}-attempt[0-9]+$`, 'u').test(artifact)) throw new Error('Invalid original native artifact name');
    const directory = join(root, artifact);
    const build = await jsonFile(join(directory, 'build-record.json')); const receipt = await jsonFile(join(directory, 'native-receipt.json'));
    if (!record(build) || build.version !== 1 || build.development !== false || build.source !== intent.source || build.release !== intent.release
      || build.platform !== 'linux/' + arch || typeof build.base !== 'string' || typeof build.buildkit !== 'string' || typeof build.lockSha256 !== 'string'
      || !Array.isArray(build.records) || build.records.length !== 2 || !record(receipt) || receipt.version !== 1 || receipt.kind !== 'native-model-mock'
      || receipt.source !== intent.source || receipt.release !== intent.release || receipt.runId !== intent.runId || receipt.artifact !== artifact || receipt.platform !== build.platform
      || typeof receipt.tests !== 'number' || receipt.tests < 11 || !record(receipt.images)) throw new Error('Native candidate source or test proof mismatch');
    const pinRecord = { base: build.base, buildkit: build.buildkit, lockSha256: build.lockSha256 };
    if (commonPins !== undefined && JSON.stringify(pinRecord) !== commonPins) throw new Error('Native dependency pin mismatch');
    commonPins = JSON.stringify(pinRecord); base = build.base; pins = pinRecord;
    for (const harness of ['pi', 'opencode'] as const) {
      const values = build.records.filter(v => record(v) && v.harness === harness); const value = values[0]; const proof = receipt.images[harness];
      if (values.length !== 1 || !record(value) || value.archive !== `${harness}-${arch}.oci.tar` || value.platform !== build.platform || typeof value.reference !== 'string'
        || typeof value.archiveSha256 !== 'string' || !record(proof) || proof.config !== value.reference || proof.archiveSha256 !== value.archiveSha256) throw new Error('Native image proof mismatch');
      const archive = join(directory, value.archive);
      if (await fileDigest(archive) !== value.archiveSha256) throw new Error('Original candidate archive integrity mismatch');
      const candidate = await inspectCandidate(archive, arch, value.reference);
      if (candidate.descriptor.digest !== proof.manifest) throw new Error('Executed native manifest mismatch');
      candidates[harness].push(candidate);
      const inventory = await jsonFile(join(directory, `${harness}-${arch}.inventory.json`));
      if (!record(inventory) || inventory.version !== 1 || inventory.development !== false || inventory.source !== intent.source || inventory.release !== intent.release
        || inventory.harness !== harness || inventory.base !== base || typeof inventory.harnessVersion !== 'string' || !Array.isArray(inventory.packages) || !Array.isArray(inventory.osPackages)) throw new Error('Native inventory identity mismatch');
      inventories.push({ harness, arch, inventory });
      provenance.push({ harness, arch, archiveSha256: value.archiveSha256, verification: await verifyAttestation(archive, intent.source, 'ci.yml', token) });
    }
  }
  if (base === undefined || pins === undefined) throw new Error('Missing native candidates');
  return { candidates, inventories, provenance, base, pins };
}
function spdx(intent: ReleaseIntent, inputs: NativeInputs, created: string): unknown {
  const packages: Record<string, unknown>[] = []; const seen = new Set<string>();
  const add = (name: string, version: string, purl: string, comment: string, license: unknown = 'NOASSERTION') => {
    const key = purl + comment; if (seen.has(key)) return; seen.add(key);
    packages.push({ SPDXID: 'SPDXRef-Package-' + (packages.length + 1), name, versionInfo: version, downloadLocation: 'NOASSERTION', filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION', licenseDeclared: typeof license === 'string' && /^[A-Za-z0-9().+ -]+$/u.test(license) ? license : 'NOASSERTION', copyrightText: 'NOASSERTION',
      comment, externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: purl }] });
  };
  for (const entry of inputs.inventories) {
    if (!record(entry) || !record(entry.inventory)) throw new Error('Invalid inventory'); const inventory = entry.inventory;
    add('node', String(inventory.nodeVersion), 'pkg:generic/node@' + encodeURIComponent(String(inventory.nodeVersion)), 'Node runtime from pinned base ' + inputs.base);
    for (const p of Array.isArray(inventory.packages) ? inventory.packages : []) {
      if (!record(p) || typeof p.name !== 'string' || typeof p.version !== 'string' || typeof p.sha256 !== 'string') throw new Error('Invalid SDK package inventory');
      add(p.name, p.version, 'pkg:npm/' + p.name.split('/').map(encodeURIComponent).join('/') + '@' + encodeURIComponent(p.version),
        'Selected SDK dependency; package.json SHA256 (not whole package checksum): ' + p.sha256, p.license);
    }
    for (const p of Array.isArray(inventory.osPackages) ? inventory.osPackages : []) {
      if (!record(p) || typeof p.name !== 'string' || typeof p.version !== 'string' || typeof p.architecture !== 'string') throw new Error('Invalid OS package inventory');
      add(p.name, p.version, `pkg:deb/debian/${encodeURIComponent(p.name)}@${encodeURIComponent(p.version)}?arch=${encodeURIComponent(p.architecture)}`, 'Debian package database in pinned base ' + inputs.base);
    }
  }
  return { spdxVersion: 'SPDX-2.3', dataLicense: 'CC0-1.0', SPDXID: 'SPDXRef-DOCUMENT', name: 'Redline worker inventory ' + intent.release,
    documentNamespace: `https://github.com/dragoscirjan/redline/releases/${intent.release}/${intent.source}/spdx`,
    creationInfo: { created, creators: ['Tool: redline-release-v1'] },
    comment: 'Coverage: selected SDK npm dependencies, Node runtime and Debian package database. Base global package-manager dependency closures are not enumerated. Image digests and the frozen lockfile bind complete bytes; package.json hashes are explicitly not complete package hashes.', packages,
    relationships: packages.map(p => ({ spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: p.SPDXID })) };
}
export async function prepareRelease(source: string, nativeRoot: string, output: string, intent: ReleaseIntent, token: string): Promise<ReleaseRecord> {
  const pkg = await jsonFile(join(source, 'package.json'));
  if (!record(pkg) || pkg.name !== '@dragoscirjan/redline' || pkg.version !== intent.release || ['1.0.0', '1.1.0'].includes(intent.release)) throw new Error('A new authoritative package version is required');
  const git = async (...args: string[]) => (await exec('git', args, { cwd: source, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, maxBuffer: 1024 * 1024 })).stdout.trim();
  if (await git('rev-parse', 'HEAD') !== intent.source || await git('status', '--porcelain=v1') !== '') throw new Error('Candidate assembly requires the exact clean validated source');
  await assertPublishOnlyChangesets(join(source, '.changeset'));
  const inputs = await nativeInputs(nativeRoot, intent, token);
  const sourcePins = await jsonFile(join(source, 'containers/pins.json'));
  if (!record(sourcePins) || sourcePins.node !== inputs.base || sourcePins.buildkit !== inputs.pins.buildkit
    || await fileDigest(join(source, 'containers/pnpm-lock.yaml')) !== inputs.pins.lockSha256 || !record(sourcePins.harnesses)) throw new Error('Native pins differ from the validated source');
  const sourceHarnesses = sourcePins.harnesses;
  if (!inputs.inventories.every(v => record(v) && record(v.inventory) && v.inventory.harnessVersion === sourceHarnesses[String(v.harness)])) throw new Error('Native SDK version differs from the validated source');
  const images: { pi?: ReleaseImage; opencode?: ReleaseImage } = {};
  const workerImages: Record<string, unknown> = {};
  await mkdir(output, { recursive: true, mode: 0o700 });
  for (const harness of ['pi', 'opencode'] as const) {
    const combined = combinePlatforms(inputs.candidates[harness]);
    const inventory = inputs.inventories.find(v => record(v) && v.harness === harness);
    if (!record(inventory) || !record(inventory.inventory) || typeof inventory.inventory.harnessVersion !== 'string') throw new Error('Missing pinned SDK version');
    const harnessVersion = inventory.inventory.harnessVersion;
    const platforms: ReleaseImage['platforms'][number][] = [];
    for (const candidate of inputs.candidates[harness]) platforms.push({ architecture: candidate.descriptor.platform.architecture, manifest: candidate.descriptor.digest,
      config: candidate.config.digest, archiveSha256: await fileDigest(candidate.archive) });
    images[harness] = { repository: `dragoscirjan/redline-${harness}`, digest: combined.digest, harnessVersion, platforms };
    workerImages[harness] = { reference: `ghcr.io/dragoscirjan/redline-${harness}@${combined.digest}`, harnessVersion, platforms: ['linux/amd64', 'linux/arm64'] };
    await writeFile(join(output, `${harness}-index.json`), combined.bytes);
  }
  const worker = parseWorkerManifest({ version: 1, release: intent.release, revision: intent.source, development: false, images: workerImages }, intent.release, false);
  const manifestPath = join(source, 'src/harness-worker/worker-images.json'); const original = await readFile(manifestPath);
  let packed: Awaited<ReturnType<typeof packCandidate>>;
  try { await writeFile(manifestPath, JSON.stringify(worker, null, 2) + '\n'); packed = await packCandidate(source, output); }
  finally { await writeFile(manifestPath, original); }
  const npm = { filename: packed.filename, sha256: createHash('sha256').update(packed.bytes).digest('hex'), integrity: 'sha512-' + createHash('sha512').update(packed.bytes).digest('base64') };
  const npmCandidateChecks = await verifyOfflineCandidate(join(output, npm.filename), intent.release);
  const date = await git('show', '-s', '--format=%cI', 'HEAD'); const created = new Date(date).toISOString().replace('.000Z', 'Z');
  await writeFile(join(output, 'worker-sbom.spdx.json'), JSON.stringify(spdx(intent, inputs, created), null, 2) + '\n');
  await writeFile(join(output, 'build-provenance.json'), JSON.stringify({ version: 1, source: intent.source, runId: intent.runId, pins: inputs.pins,
    nativeSubjects: inputs.provenance, npmCandidateChecks, npmSubject: { ...npm, attestationRepository: 'dragoscirjan/redline', signerWorkflow: '.github/workflows/npm.release.yml', sourceRef: 'refs/heads/main', sourceDigest: intent.source,
      npmRegistryProvenance: 'Required and anonymously verified before the GitHub Release becomes public.' } }, null, 2) + '\n');
  const asset = async (name: string) => { const bytes = await readFile(join(output, name)); return { name, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }; };
  const assets = await Promise.all([npm.filename, 'worker-sbom.spdx.json', 'build-provenance.json'].map(asset));
  await writeFile(join(output, 'checksums.json'), JSON.stringify({ version: 1, files: assets }, null, 2) + '\n'); assets.push(await asset('checksums.json'));
  if (images.pi === undefined || images.opencode === undefined) throw new Error('Both worker variants are required');
  const manifest = parseReleaseRecord({ version: 1, package: '@dragoscirjan/redline', ...intent, base: inputs.base, npm, images, assets });
  await writeFile(join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
