import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { fileDigest } from '../src/harness-worker/build.ts';
import { digest, OCI_INDEX, OCI_MANIFEST } from '../src/release/oci.ts';
import { nativeInputs, prepareRelease, type ReleaseIntent } from '../src/release/prepare.ts';
import { validateStage } from '../src/release/main.ts';
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.runIf(process.platform === 'linux')('assembles a complete immutable release from two synthetic native proofs and checks the exact npm candidate offline', async () => {
  // Synthetic archives and a deliberately fake gh verifier test orchestration, NOT signatures or native execution.
  const root = await mkdtemp(join(tmpdir(), 'redline-assembly-test-')); roots.push(root);
  const project = fileURLToPath(new URL('../', import.meta.url)); const source = join(root, 'source'); await mkdir(source);
  for (const directory of ['src', 'bin', 'schemas', 'prompts']) await cp(join(project, directory), join(source, directory), { recursive: true });
  await mkdir(join(source, 'docs')); await mkdir(join(source, 'containers')); await mkdir(join(source, '.changeset'));
  const pkg = JSON.parse(await readFile(join(project, 'package.json'), 'utf8')); pkg.version = '1.2.0';
  await writeFile(join(source, 'package.json'), JSON.stringify(pkg, null, 2));
  for (const name of ['README.md', 'LICENSE']) await cp(join(project, name), join(source, name));
  for (const name of ['local-cli.md', 'portable-architecture.md', 'internal-worker-protocol.md', 'stdio-protocol.md', 'docker-workers.md', 'coordinated-releases.md']) await cp(join(project, 'docs', name), join(source, 'docs', name));
  for (const name of ['pins.json', 'pnpm-lock.yaml']) await cp(join(project, 'containers', name), join(source, 'containers', name));
  await writeFile(join(source, '.changeset/config.json'), '{}');
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args: string[]) => execFileSync('git', ['-C', source, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], { env, encoding: 'utf8' }).trim();
  git('init', '--quiet', '-b', 'main'); git('config', 'user.name', 'Assembly fixture'); git('config', 'user.email', 'assembly@example.invalid'); git('add', '.'); git('commit', '--quiet', '-m', 'fixture');
  const sha = git('rev-parse', 'HEAD');
  const intent: ReleaseIntent = { release: '1.2.0', source: sha, runId: '123', candidateArtifact: `release-candidate-${sha}-123-attempt1`,
    artifacts: { amd64: 'worker-native-amd64-123-attempt1', arm64: 'worker-native-arm64-123-attempt1' } };
  const pins = JSON.parse(await readFile(join(source, 'containers/pins.json'), 'utf8')); const nativeRoot = join(root, 'native'); await mkdir(nativeRoot);
  for (const architecture of ['amd64', 'arm64'] as const) {
    const directory = join(nativeRoot, intent.artifacts[architecture]); await mkdir(directory);
    const records: unknown[] = []; const images: Record<string, unknown> = {};
    for (const harness of ['pi', 'opencode'] as const) {
      const data = join(root, `oci-${harness}-${architecture}`); await mkdir(join(data, 'blobs/sha256'), { recursive: true });
      const config = Buffer.from(JSON.stringify({ architecture, os: 'linux', config: {}, rootfs: { type: 'layers', diff_ids: [] } }));
      const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: OCI_MANIFEST, config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: digest(config), size: config.length }, layers: [] }));
      const descriptor = { mediaType: OCI_MANIFEST, digest: digest(manifest), size: manifest.length, platform: { os: 'linux', architecture } };
      for (const bytes of [config, manifest]) await writeFile(join(data, 'blobs/sha256', digest(bytes).slice(7)), bytes);
      await writeFile(join(data, 'index.json'), JSON.stringify({ schemaVersion: 2, mediaType: OCI_INDEX, manifests: [descriptor] }));
      const name = `${harness}-${architecture}.oci.tar`; const archive = join(directory, name);
      execFileSync('tar', ['-cf', archive, '-C', data, 'index.json', 'blobs'], { env });
      const checksum = await fileDigest(archive);
      records.push({ harness, platform: 'linux/' + architecture, reference: digest(config), archive: name, archiveSha256: checksum });
      images[harness] = { config: digest(config), manifest: digest(manifest), archiveSha256: checksum };
      await writeFile(join(directory, `${harness}-${architecture}.inventory.json`), JSON.stringify({ version: 1, development: false, source: sha, release: '1.2.0', harness, base: pins.node,
        harnessVersion: pins.harnesses[harness], nodeVersion: 'v24.21.0', packages: [{ name: harness, version: pins.harnesses[harness], sha256: 'f'.repeat(64), license: 'MIT' }],
        osPackages: [{ name: 'libc6', version: '2.36', architecture }] }));
    }
    await writeFile(join(directory, 'build-record.json'), JSON.stringify({ version: 1, development: false, source: sha, release: '1.2.0', platform: 'linux/' + architecture,
      base: pins.node, buildkit: pins.buildkit, lockSha256: await fileDigest(join(source, 'containers/pnpm-lock.yaml')), records }));
    await writeFile(join(directory, 'native-receipt.json'), JSON.stringify({ version: 1, kind: 'native-model-mock', source: sha, release: '1.2.0', runId: '123',
      artifact: intent.artifacts[architecture], platform: 'linux/' + architecture, tests: 11, images }));
  }
  const bin = join(root, 'bin'); await mkdir(bin); const calls = join(root, 'verifier-calls.jsonl');
  await writeFile(join(bin, 'gh'), `#!${process.execPath}
const fs=require('node:fs');if(process.env.GH_TOKEN!=='unit-attestation-token'||!process.env.HOME||!process.env.GH_CONFIG_DIR.startsWith(process.env.HOME))process.exit(1);
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({args:process.argv.slice(2),keys:Object.keys(process.env),home:process.env.HOME})+'\\n');
console.log(JSON.stringify([{unitFixture:true,warning:'Not cryptographic proof'}]));
`, { mode: 0o700 });
  vi.stubEnv('PATH', bin + delimiter + (process.env.PATH ?? '')); vi.stubEnv('REDLINE_MODEL_AUTH', 'synthetic-ambient-key-must-not-reach-verifier');
  const original = await readFile(join(source, 'src/harness-worker/worker-images.json'), 'utf8'); const stage = join(root, 'stage');
  const result = await prepareRelease(source, nativeRoot, stage, intent, 'unit-attestation-token');
  expect(await validateStage(stage, result)).toEqual(result); expect(result.images.pi.platforms).toHaveLength(2); expect(result.images.opencode.platforms).toHaveLength(2);
  expect(await readFile(join(source, 'src/harness-worker/worker-images.json'), 'utf8')).toBe(original); expect(git('status', '--porcelain=v1')).toBe('');
  const embedded = JSON.parse(execFileSync('tar', ['-xOf', join(stage, result.npm.filename), 'package/src/harness-worker/worker-images.json'], { env, encoding: 'utf8' }));
  expect(embedded).toMatchObject({ release: '1.2.0', revision: sha, development: false });
  expect(embedded.images.pi.reference).toBe(`ghcr.io/${result.images.pi.repository}@${result.images.pi.digest}`);
  const sbom = JSON.parse(await readFile(join(stage, 'worker-sbom.spdx.json'), 'utf8')); expect(sbom.spdxVersion).toBe('SPDX-2.3'); expect(sbom.packages.some((p: { name: string }) => p.name === 'libc6')).toBe(true);
  const verification = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); expect(verification).toHaveLength(4);
  for (const call of verification) { expect(call.args).toContain(sha); expect(call.keys).not.toContain('REDLINE_MODEL_AUTH'); expect(call.home).not.toBe(root); }
  await writeFile(join(stage, result.npm.filename), 'tampered'); await expect(validateStage(stage, result)).rejects.toThrow('integrity');
  await writeFile(join(nativeRoot, intent.artifacts.amd64, 'pi-amd64.oci.tar'), 'tampered');
  await expect(nativeInputs(nativeRoot, intent, 'unit-attestation-token')).rejects.toThrow('archive integrity');
}, 60_000);
