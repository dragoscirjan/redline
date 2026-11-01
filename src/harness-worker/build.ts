import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { record, type WorkerHarness } from './contract.ts';

const exec = promisify(execFile);
const source = fileURLToPath(new URL('../../', import.meta.url));
export async function fileDigest(path: string): Promise<string> {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex');
}
export async function buildWorkers(args: readonly string[]): Promise<string> {
  const values = parseArgs({ args: [...args], strict: true, options: { output: { type: 'string' }, oci: { type: 'boolean' }, release: { type: 'boolean' } } }).values;
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) throw new Error('Worker builds require native Linux amd64 or arm64');
  const output = values.output === undefined ? await mkdtemp(join(tmpdir(), 'redline-worker-build-')) : resolve(values.output);
  if (values.output !== undefined) {
    await mkdir(output, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(output);
    if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(output)).length !== 0) throw new Error('Worker output must be a new or empty regular directory');
  }
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8',
    DOCKER_HOST: process.env.DOCKER_HOST, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT, DOCKER_CONFIG: process.env.DOCKER_CONFIG, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR };
  const git = async (...argv: string[]): Promise<string> => (await exec('git', argv, { cwd: source, env, maxBuffer: 1024 * 1024 })).stdout.trim();
  const revision = await git('rev-parse', 'HEAD');
  if (!/^[a-f0-9]{40}$/u.test(revision)) throw new Error('Invalid source revision');
  const development = values.release !== true;
  if (!development && await git('status', '--porcelain=v1') !== '') throw new Error('Release image builds require the exact clean source commit');
  const epoch = await git('show', '-s', '--format=%ct', 'HEAD');
  if (!/^[0-9]+$/u.test(epoch)) throw new Error('Invalid source timestamp');
  const pkg = JSON.parse(await readFile(resolve(source, 'package.json'), 'utf8'));
  const pins = JSON.parse(await readFile(resolve(source, 'containers/pins.json'), 'utf8'));
  const arch = process.arch === 'x64' ? 'amd64' : 'arm64';
  const platform = 'linux/' + arch;
  const builder = 'redline-build-' + randomUUID();
  const docker = async (argv: string[], timeout = 600_000): Promise<string> => {
    try {
      const result = await exec('docker', argv, { cwd: source, env, timeout, maxBuffer: 16 * 1024 * 1024 });
      return result.stdout.trim();
    } catch (error) {
      // Build output contains only trusted source/dependency data, not model/publication credentials.
      if (record(error) && typeof error.stderr === 'string') process.stderr.write(error.stderr.slice(-16 * 1024));
      throw new Error(`Worker image build failed during docker ${argv[0]}`);
    }
  };
  const manifest = { version: 1, release: String(pkg.version), revision, development, images: {} as Record<WorkerHarness, { reference: string; harnessVersion: string; platforms: string[] }> };
  const records: Record<string, unknown>[] = [];
  let builderCreated = false;
  try {
    await docker(['buildx', 'create', '--name', builder, '--driver', 'docker-container', '--driver-opt', 'image=' + String(pins.buildkit)]);
    builderCreated = true;
    for (const harness of ['pi', 'opencode'] as const) {
      const tag = `redline-build-${harness}:${revision}-${arch}${development ? '-' + randomUUID() : ''}`;
      const archive = resolve(output, `${harness}-${arch}.oci.tar`);
      const metadata = resolve(output, `${harness}-${arch}.build.json`);
      const argv = ['buildx', 'build', '--builder', builder, '--platform', platform, '--target', harness, '--file', 'containers/Dockerfile',
        '--build-arg', 'REDLINE_REVISION=' + revision, '--build-arg', 'SOURCE_DATE_EPOCH=' + epoch,
        '--build-arg', 'REDLINE_SOURCE_KIND=' + (development ? 'development' : 'release'),
        '--provenance=false', '--sbom=false', '--metadata-file', metadata, '--tag', tag,
        '--output', 'type=docker,rewrite-timestamp=true'];
      if (values.oci) argv.push('--output', `type=oci,dest=${archive},rewrite-timestamp=true,oci-mediatypes=true`);
      argv.push('.');
      process.stderr.write(`Building ${harness} ${platform} with pinned dependencies\n`);
      await docker(argv);
      const id = await docker(['image', 'inspect', tag, '--format', '{{.Id}}']);
      if (!/^sha256:[a-f0-9]{64}$/u.test(id)) throw new Error('Invalid built image identity');
      manifest.images[harness] = { reference: id, harnessVersion: pins.harnesses[harness], platforms: [platform] };
      const container = await docker(['create', '--read-only', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true', '--entrypoint', '/bin/true', id]);
      if (!/^[a-f0-9]{64}$/u.test(container)) throw new Error('Invalid metadata container identity');
      try {
        await docker(['cp', container + ':/opt/redline/worker-inventory.json', resolve(output, `${harness}-${arch}.inventory.json`)]);
        await docker(['cp', container + ':/opt/redline/worker.json', resolve(output, `${harness}-${arch}.identity.json`)]);
      } finally { await docker(['rm', container], 15_000); }
      records.push({ harness, platform, reference: id, archive: values.oci ? `${harness}-${arch}.oci.tar` : null,
        archiveSha256: values.oci ? await fileDigest(archive) : null, identity: `${harness}-${arch}.identity.json`, inventory: `${harness}-${arch}.inventory.json` });
    }
    // Development manifests identify immutable local images. Release assembly replaces references with registry digests.
    const path = resolve(output, 'worker-manifest.json');
    await writeFile(path, JSON.stringify({ ...manifest, development: true }, null, 2) + '\n', { mode: 0o644 });
    await writeFile(resolve(output, 'build-record.json'), JSON.stringify({ version: 1, source: revision, release: pkg.version, development, platform, base: pins.node,
      buildkit: pins.buildkit, lockSha256: await fileDigest(resolve(source, 'containers/pnpm-lock.yaml')), records }, null, 2) + '\n', { mode: 0o644 });
    return path;
  } finally { if (builderCreated) await docker(['buildx', 'rm', builder], 30_000); }
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildWorkers(process.argv.slice(2)).then(path => process.stdout.write(path + '\n')).catch(() => { process.stderr.write('redline worker build failed\n'); process.exitCode = 1; });
}
