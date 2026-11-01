import { createHash } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isRecord as record } from '../process-runner.ts';
import { coordinateRelease, parseReleaseRecord, recordIdentity, type ReleasePorts, type ReleaseRecord } from './coordinator.ts';
import { classifyReleaseChangesets } from './npm-check.ts';
import { GitHubReleases } from './github.ts';
import { combinePlatforms, OciRegistry } from './oci.ts';
import { pullPublicImages } from './verification.ts';
import { assertNpmPublicationContext, installAnonymous, npmIntegrity, publishNpm, waitForIdentity } from './npm-registry.ts';
import { fileBytes, jsonFile, nativeInputs, prepareRelease, verifyAttestation, type ReleaseIntent } from './prepare.ts';
import { checkNativeTests } from './native-receipt.ts';
const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
function required(name: string): string { const value = process.env[name]; if (value === undefined || value === '') throw new Error('Missing trusted release input: ' + name); return value; }
function ci(): { source: string; runId: string; attempt: string } {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== 'dragoscirjan/redline' || process.env.GITHUB_EVENT_NAME !== 'push'
    || process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Coordinated release writes require the trusted main CI');
  const source = required('GITHUB_SHA'); const runId = required('GITHUB_RUN_ID'); const attempt = required('GITHUB_RUN_ATTEMPT');
  if (!/^[a-f0-9]{40}$/u.test(source) || !/^[0-9]{1,32}$/u.test(runId) || !/^[0-9]+$/u.test(attempt)) throw new Error('Invalid trusted CI identity');
  return { source, runId, attempt };
}
async function outputs(values: Record<string, string>): Promise<void> {
  for (const [key, value] of Object.entries(values)) { if (/[\r\n]/u.test(value)) throw new Error('Invalid release step output'); await appendFile(required('GITHUB_OUTPUT'), `${key}=${value}\n`); }
}
function savedRecord(): ReleaseRecord | undefined {
  const value = process.env.RELEASE_RECORD;
  return value === undefined || value === '' ? undefined : parseReleaseRecord(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
}
export async function releasePlan(github: GitHubReleases): Promise<void> {
  const context = ci(); const pkg = await jsonFile(join(sourceRoot, 'package.json'));
  if (!record(pkg) || pkg.name !== '@dragoscirjan/redline' || typeof pkg.version !== 'string') throw new Error('Package identity unavailable');
  const mode = await classifyReleaseChangesets(join(sourceRoot, '.changeset'));
  if (mode === 'version') { await outputs({ mode: 'version' }); return; }
  const existing = await github.find(pkg.version);
  const npm = await npmIntegrity(pkg.version);
  if (existing === undefined && ['1.0.0', '1.1.0'].includes(pkg.version) && npm !== undefined) {
    process.stdout.write('Legacy npm version left unchanged; no historical images or fresh installed-smoke claim.\n'); await outputs({ mode: 'noop' }); return;
  }
  if (existing === undefined && npm !== undefined) throw new Error('An untracked npm version already exists; do not backfill or republish');
  if (existing !== undefined && npm !== undefined && npm !== existing.record.npm.integrity) throw new Error('Existing npm version integrity conflict');
  if (existing !== undefined && !existing.draft) {
    const registry = new OciRegistry();
    if (npm !== existing.record.npm.integrity) throw new Error('Completed release npm identity unavailable');
    for (const image of [existing.record.images.pi, existing.record.images.opencode]) if ((await registry.manifest(image.repository, pkg.version))?.digest !== image.digest) throw new Error('Completed release image identity unavailable');
    process.stdout.write('Already coordinated; no publication and no fresh installed-smoke claim.\n'); await outputs({ mode: 'noop' }); return;
  }
  const runId = existing?.record.runId ?? context.runId; const source = existing?.record.source ?? context.source;
  const selection = await github.artifactSelection(runId, source, existing?.record.artifacts);
  const candidateArtifact = existing?.record.candidateArtifact ?? `release-candidate-${source}-${runId}-attempt${context.attempt}`;
  await outputs({ mode: existing === undefined ? 'prepare' : 'recover', source, 'run-id': runId, release: pkg.version, 'native-ids': selection.ids,
    'native-names': Buffer.from(JSON.stringify(selection.names)).toString('base64url'), 'candidate-artifact': candidateArtifact,
    'candidate-id': existing === undefined ? '' : String(await github.candidateArtifactId(existing.record)),
    record: existing === undefined ? '' : Buffer.from(JSON.stringify(existing.record)).toString('base64url') });
}
function intent(): ReleaseIntent {
  const prior = savedRecord(); if (prior !== undefined) return prior;
  const artifacts: unknown = JSON.parse(Buffer.from(required('NATIVE_NAMES'), 'base64url').toString('utf8'));
  if (!record(artifacts) || typeof artifacts.amd64 !== 'string' || typeof artifacts.arm64 !== 'string') throw new Error('Missing native artifact names');
  return { release: required('RELEASE_VERSION'), source: required('RELEASE_SOURCE'), runId: required('SOURCE_RUN_ID'), candidateArtifact: required('CANDIDATE_ARTIFACT'), artifacts: { amd64: artifacts.amd64, arm64: artifacts.arm64 } };
}
export async function validateStage(directory: string, expected?: ReleaseRecord): Promise<ReleaseRecord> {
  const manifest = parseReleaseRecord(await jsonFile(join(directory, 'release-manifest.json')));
  if (expected !== undefined && recordIdentity(expected) !== recordIdentity(manifest)) throw new Error('Recovered release candidate identity conflict');
  for (const asset of manifest.assets) {
    const bytes = await fileBytes(join(directory, asset.name));
    if (bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('Staged release asset integrity conflict');
  }
  const tarball = await fileBytes(join(directory, manifest.npm.filename));
  if ('sha512-' + createHash('sha512').update(tarball).digest('base64') !== manifest.npm.integrity) throw new Error('Staged npm integrity conflict');
  for (const h of ['pi', 'opencode'] as const) if ('sha256:' + createHash('sha256').update(await readFile(join(directory, h + '-index.json'))).digest('hex') !== manifest.images[h].digest) throw new Error('Staged index integrity conflict');
  return manifest;
}
async function visible(manifest: ReleaseRecord): Promise<void> {
  await waitForIdentity(() => npmIntegrity(manifest.release), manifest.npm.integrity, 'npm');
  const registry = new OciRegistry();
  for (const image of [manifest.images.pi, manifest.images.opencode]) {
    await waitForIdentity(async () => (await registry.manifest(image.repository, manifest.release))?.digest, image.digest, 'image');
    await waitForIdentity(async () => (await registry.manifest(image.repository, image.digest))?.digest, image.digest, 'image digest');
  }
}
async function publish(directory: string, github: GitHubReleases): Promise<void> {
  const manifest = await validateStage(directory, savedRecord());
  const inputs = await nativeInputs(required('NATIVE_ROOT'), manifest, required('GH_TOKEN'));
  for (const h of ['pi', 'opencode'] as const) {
    if (combinePlatforms(inputs.candidates[h]).digest !== manifest.images[h].digest) throw new Error('Recovered native runtime identity conflict');
    for (const candidate of inputs.candidates[h]) {
      const platform = manifest.images[h].platforms.find(p => p.architecture === candidate.descriptor.platform.architecture);
      if (platform?.manifest !== candidate.descriptor.digest || platform.config !== candidate.config.digest) throw new Error('Recovered platform identity conflict');
    }
  }
  await verifyAttestation(join(directory, manifest.npm.filename), manifest.source, 'npm.release.yml', required('GH_TOKEN'));
  const registry = new OciRegistry({ username: required('GITHUB_ACTOR'), token: required('GH_TOKEN') });
  const ports: ReleasePorts = {
    async reserve(record) {
      await github.reserve(record);
      for (const asset of record.assets) await github.attach(record, asset.name, await readFile(join(directory, asset.name)));
      await github.attach(record, 'release-manifest.json', Buffer.from(JSON.stringify(record, null, 2) + '\n'));
    }, npmIntegrity,
    async publishNpm(record) {
      assertNpmPublicationContext(record);
      const token = required('NPM_TOKEN');
      await github.markNpmAttempt(record);
      await publishNpm(join(directory, record.npm.filename), record, token);
      await waitForIdentity(() => npmIntegrity(record.release), record.npm.integrity, 'npm');
    },
    async imageDigest(repository, version) { return (await registry.manifest(repository, version))?.digest; },
    async publishImage(image, version) {
      const h = image.repository.endsWith('-pi') ? 'pi' : 'opencode';
      for (const candidate of inputs.candidates[h]) await registry.publishCandidate(image.repository, candidate);
      const index = await readFile(join(directory, h + '-index.json'));
      await registry.publishManifest(image.repository, image.digest, index, 'application/vnd.oci.image.index.v1+json');
      await registry.publishManifest(image.repository, version, index, 'application/vnd.oci.image.index.v1+json');
    }, verifyPublic: visible,
    async finalize() { throw new Error('Native anonymous verification must finish before finalization'); },
  };
  await coordinateRelease(manifest, ports);
}
async function finalize(directory: string, github: GitHubReleases): Promise<void> {
  const manifest = await validateStage(directory, savedRecord()); const receipts = required('PUBLIC_RECEIPTS');
  for (const arch of ['amd64', 'arm64'] as const) {
    const value = await jsonFile(join(receipts, arch + '.json'));
    if (!record(value) || value.version !== 1 || value.kind !== 'public-native-model-mock' || value.identity !== recordIdentity(manifest)
      || value.platform !== 'linux/' + arch || value.runId !== required('GITHUB_RUN_ID') || value.npmIntegrity !== manifest.npm.integrity
      || typeof value.tests !== 'number' || value.tests < 11) throw new Error('Native anonymous verification receipt mismatch');
  }
  const ports: ReleasePorts = {
    async reserve(record) { await github.reserve(record); }, npmIntegrity,
    async publishNpm() { throw new Error('Finalization cannot publish npm'); },
    async imageDigest(repository, version) { return (await new OciRegistry().manifest(repository, version))?.digest; },
    async publishImage() { throw new Error('Finalization cannot publish images'); }, verifyPublic: visible,
    async finalize(record) { await github.finalize(record); },
  };
  await coordinateRelease(manifest, ports, true);
}
export async function releaseMain(args: readonly string[]): Promise<void> {
  if (args.length !== 1) throw new Error('Exactly one release operation is required; versions come only from package metadata');
  const command = args[0]; ci();
  if (command === 'plan') { await releasePlan(new GitHubReleases(required('GH_TOKEN'))); return; }
  const directory = resolve(required('RELEASE_DIRECTORY'));
  if (command === 'prepare') { await prepareRelease(sourceRoot, required('NATIVE_ROOT'), directory, intent(), required('GH_TOKEN')); return; }
  if (command === 'restore') { await validateStage(directory, savedRecord()); return; }
  if (command === 'describe') {
    const manifest = await validateStage(directory, savedRecord());
    await outputs({ record: Buffer.from(JSON.stringify(manifest)).toString('base64url') }); return;
  }
  if (command === 'install') {
    const manifest = await validateStage(directory, savedRecord());
    const binary = await installAnonymous(manifest, required('PUBLIC_INSTALLATION'));
    await pullPublicImages(manifest, required('PUBLIC_INSTALLATION'));
    await outputs({ binary }); return;
  }
  if (command === 'public-receipt') {
    const manifest = await validateStage(directory, savedRecord());
    const tests = await checkNativeTests(required('PUBLIC_TEST_RESULTS'));
    const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64' : undefined;
    if (process.platform !== 'linux' || arch === undefined) throw new Error('Native public verification requires Linux');
    const path = required('PUBLIC_RECEIPT');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, JSON.stringify({ version: 1, kind: 'public-native-model-mock', identity: recordIdentity(manifest), platform: 'linux/' + arch,
      runId: required('GITHUB_RUN_ID'), npmIntegrity: manifest.npm.integrity, tests }, null, 2) + '\n'); return;
  }
  const github = new GitHubReleases(required('GH_TOKEN'));
  if (command === 'publish') { await publish(directory, github); return; }
  if (command === 'finalize') { await finalize(directory, github); return; }
  throw new Error('Unknown coordinated release command');
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  releaseMain(process.argv.slice(2)).catch(error => {
    process.stderr.write('Coordinated release failed; preserve existing artifacts and the draft.\n');
    if (error instanceof Error) process.stderr.write(error.message + '\n'); process.exitCode = 1;
  });
}
