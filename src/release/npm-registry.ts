import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { record } from '../harness-worker/contract.ts';
import type { ReleaseRecord } from './coordinator.ts';
import { responseBytes } from './http.ts';
const exec = promisify(execFile);

export async function npmIntegrity(version: string, origin = 'https://registry.npmjs.org'): Promise<string | undefined> {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/u.test(version)) throw new Error('Invalid exact npm version');
  const base = new URL(origin);
  if (origin !== 'https://registry.npmjs.org' && !(base.protocol === 'http:' && base.hostname === '127.0.0.1')) throw new Error('Invalid npm registry origin');
  const url = new URL('/@dragoscirjan%2fredline/' + version, base); url.searchParams.set('redline_visibility', randomUUID());
  const response = await fetch(url, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { 'cache-control': 'no-cache', pragma: 'no-cache' } });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error('Exact anonymous npm metadata unavailable');
  const value: unknown = JSON.parse((await responseBytes(response, 1024 * 1024)).toString('utf8'));
  if (!record(value) || value.name !== '@dragoscirjan/redline' || value.version !== version || !record(value.dist) || typeof value.dist.integrity !== 'string') throw new Error('Invalid exact npm metadata');
  return value.dist.integrity;
}
export async function waitForIdentity(check: () => Promise<string | undefined>, expected: string, label: string, budgetMs = 120_000): Promise<void> {
  const end = Date.now() + budgetMs; let delay = 1000;
  while (true) {
    const actual = await check();
    if (actual === expected) return;
    if (actual !== undefined) throw new Error('Immutable ' + label + ' identity conflict');
    if (Date.now() >= end) throw new Error(label + ' is not anonymously visible within the readiness budget');
    await new Promise(resolve => setTimeout(resolve, Math.min(delay, Math.max(0, end - Date.now())))); delay = Math.min(delay * 2, 30_000);
  }
}
async function npmEnvironment(root: string, token?: string): Promise<NodeJS.ProcessEnv> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const config = join(root, 'npmrc'); const global = join(root, 'global-npmrc');
  await writeFile(config, 'registry=https://registry.npmjs.org/\nignore-scripts=true\n' + (token === undefined ? '' : '//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n'), { mode: 0o600 });
  await writeFile(global, '', { mode: 0o600 });
  return { PATH: process.env.PATH, HOME: root, LANG: 'C.UTF-8', NPM_CONFIG_USERCONFIG: config, NPM_CONFIG_GLOBALCONFIG: global,
    NPM_CONFIG_CACHE: join(root, 'cache'), NPM_CONFIG_IGNORE_SCRIPTS: 'true', ...(token === undefined ? {} : { NODE_AUTH_TOKEN: token }) };
}
/** The exact candidate tarball is the publication input; no rebuild or lifecycle script can change it. */
export function assertNpmPublicationContext(manifest: ReleaseRecord): void {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== 'dragoscirjan/redline'
    || process.env.GITHUB_REF !== 'refs/heads/main' || process.env.GITHUB_EVENT_NAME !== 'push'
    || process.env.GITHUB_SHA !== manifest.source || process.env.GITHUB_RUN_ID !== manifest.runId) throw new Error('npm provenance requires the original validated main workflow source; rerun that owner-controlled run');
}
export async function publishNpm(tarball: string, manifest: ReleaseRecord, token: string): Promise<void> {
  assertNpmPublicationContext(manifest);
  const root = await mkdtemp(join(tmpdir(), 'redline-publish-'));
  try {
    const env = await npmEnvironment(root, token);
    for (const name of ['ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'GITHUB_REPOSITORY_OWNER',
      'GITHUB_REPOSITORY_OWNER_ID', 'GITHUB_REPOSITORY_ID', 'GITHUB_ACTOR', 'GITHUB_ACTOR_ID', 'GITHUB_WORKFLOW', 'GITHUB_JOB', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_WORKFLOW_REF', 'GITHUB_WORKFLOW_SHA', 'GITHUB_SHA', 'GITHUB_REF', 'GITHUB_EVENT_NAME',
      'GITHUB_SERVER_URL', 'GITHUB_API_URL', 'GITHUB_TRIGGERING_ACTOR']) if (process.env[name] !== undefined) env[name] = process.env[name];
    try { await exec('npm', ['publish', tarball, '--access', 'public', '--provenance', '--ignore-scripts', '--json'], { cwd: root, env, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 }); }
    catch { throw new Error('Exact npm publication failed or its acknowledgement was lost; keep the draft and investigate without republishing'); }
  } finally { await rm(root, { recursive: true, force: true }); }
}
export async function packCandidate(source: string, destination: string): Promise<{ filename: string; bytes: Buffer }> {
  const root = await mkdtemp(join(tmpdir(), 'redline-pack-'));
  try {
    const env = await npmEnvironment(root);
    const result = await exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], { cwd: source, env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    const value: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(value) || value.length !== 1 || !record(value[0]) || typeof value[0].filename !== 'string' || !/^[A-Za-z0-9._-]+\.tgz$/u.test(value[0].filename)) throw new Error('Invalid npm candidate pack result');
    return { filename: value[0].filename, bytes: await readFile(join(destination, value[0].filename)) };
  } finally { await rm(root, { recursive: true, force: true }); }
}
/** No auth, checkout, inherited config, install scripts, shared cache, or version ranges. */
export async function installAnonymous(manifest: ReleaseRecord, destination: string): Promise<string> {
  await waitForIdentity(() => npmIntegrity(manifest.release), manifest.npm.integrity, 'npm');
  await mkdir(destination, { recursive: true, mode: 0o700 });
  let installed: string | undefined;
  let environment: NodeJS.ProcessEnv | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    // npm reads a packument independently of the exact-version endpoint. Each visibility retry
    // uses a new empty cache and directory; a warm-cache no-op is not verification.
    const current = join(destination, 'attempt-' + randomUUID()); await mkdir(current, { mode: 0o700 });
    await writeFile(join(current, 'package.json'), JSON.stringify({ name: 'redline-public-verification', version: '0.0.0', private: true }));
    const env = await npmEnvironment(join(current, 'configuration'));
    try {
      await exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-online', '--save-exact', '@dragoscirjan/redline@' + manifest.release],
        { cwd: current, env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
      installed = current; environment = env; break;
    } catch (error) {
      const diagnostic = record(error) ? String(error.stderr ?? '') + String(error.stdout ?? '') : '';
      await rm(current, { recursive: true, force: true });
      if (attempt === 4 || !/\bETARGET\b|\bE404\b/u.test(diagnostic)) throw new Error('Exact anonymous installation failed; the release stays draft');
      await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
  if (installed === undefined || environment === undefined) throw new Error('Exact anonymous installation unavailable');
  try { await exec('npm', ['audit', 'signatures', '--omit=dev'], { cwd: installed, env: environment, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }); }
  catch { throw new Error('Anonymous npm signature/provenance verification failed; the release stays draft'); }
  const lock: unknown = JSON.parse(await readFile(join(installed, 'package-lock.json'), 'utf8'));
  const packageRoot = join(installed, 'node_modules/@dragoscirjan/redline');
  const pkg: unknown = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const item = record(lock) && record(lock.packages) ? lock.packages['node_modules/@dragoscirjan/redline'] : undefined;
  const scripts = record(pkg) && record(pkg.scripts) ? pkg.scripts : undefined;
  if (!record(item) || item.version !== manifest.release || item.integrity !== manifest.npm.integrity || !record(pkg) || pkg.version !== manifest.release
    || (record(pkg.dependencies) && Object.keys(pkg.dependencies).length !== 0) || (scripts !== undefined && ['preinstall', 'install', 'postinstall'].some(name => Object.hasOwn(scripts, name)))) throw new Error('Installed npm package does not match the validated candidate');
  const images: unknown = JSON.parse(await readFile(join(packageRoot, 'src/harness-worker/worker-images.json'), 'utf8'));
  if (!record(images) || images.release !== manifest.release || images.revision !== manifest.source || !record(images.images)) throw new Error('Installed worker identity mismatch');
  for (const harness of ['pi', 'opencode'] as const) {
    const image = images.images[harness]; const expected = manifest.images[harness];
    if (!record(image) || image.reference !== `ghcr.io/${expected.repository}@${expected.digest}` || image.harnessVersion !== expected.harnessVersion) throw new Error('Installed image digest mismatch');
  }
  return join(packageRoot, 'bin/redline.mjs');
}
