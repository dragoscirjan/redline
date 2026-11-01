import { readFile, writeFile, symlink, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

const harness = process.argv[2];
if (harness !== 'pi' && harness !== 'opencode') throw new Error('Invalid worker target');
const revision = process.env.REDLINE_REVISION;
if (!/^[a-f0-9]{40}$/.test(revision ?? '')) throw new Error('REDLINE_REVISION must identify the trusted source');
const pkg = JSON.parse(await readFile('/opt/redline/package.json', 'utf8'));
const pins = JSON.parse(await readFile('/build/pins.json', 'utf8'));
if (harness === 'opencode') {
  const require = createRequire('/opt/harness/opencode/package.json');
  const root = dirname(require.resolve('opencode-ai/package.json'));
  const sdkRequire = createRequire(join(root, 'package.json'));
  const name = process.arch === 'x64' ? 'opencode-linux-x64-baseline' : process.arch === 'arm64' ? 'opencode-linux-arm64' : '';
  if (!name) throw new Error('Unsupported worker architecture');
  const source = join(dirname(sdkRequire.resolve(name + '/package.json')), 'bin/opencode');
  await symlink(source, '/opt/harness/opencode-bin');
}
const packages = [];
for (const entry of await readdir('/opt/harness/node_modules/.pnpm', { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const modules = join('/opt/harness/node_modules/.pnpm', entry.name, 'node_modules');
  for (const child of await readdir(modules, { withFileTypes: true }).catch(() => [])) {
    if (!child.isDirectory() || child.name.startsWith('.')) continue;
    const roots = child.name.startsWith('@') ? (await readdir(join(modules, child.name))).map(name => join(modules, child.name, name)) : [join(modules, child.name)];
    for (const root of roots) {
      const file = join(root, 'package.json');
      const text = await readFile(file, 'utf8').catch(() => undefined);
      if (text === undefined) continue;
      const data = JSON.parse(text);
      if (data.name && data.version) packages.push({ name: data.name, version: data.version, sha256: createHash('sha256').update(text).digest('hex'), license: data.license ?? 'NOASSERTION' });
    }
  }
}
const osPackages = execFileSync('/usr/bin/dpkg-query', ['-W', '-f=${Package}\t${Version}\t${Architecture}\n'],
  { encoding: 'utf8', maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin', LANG: 'C' } }).trim().split('\n')
  .map(line => { const [name, version, architecture] = line.split('\t'); return { name, version, architecture }; });
const bunVersion = execFileSync('/usr/local/bin/bun', ['--version'], { encoding: 'utf8', env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C' } }).trim();
if (bunVersion !== pins.bun.version) throw new Error('Bun runtime does not match its pin');
packages.push({ name: 'bun', version: bunVersion, sha256: createHash('sha256').update(await readFile('/usr/local/bin/bun')).digest('hex'), license: 'MIT' });
packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
await writeFile('/opt/redline/worker.json', JSON.stringify({ harness, release: pkg.version, revision, harnessVersion: pins.harnesses[harness] }) + '\n');
await writeFile('/opt/redline/worker-inventory.json', JSON.stringify({ version: 1, development: process.env.REDLINE_SOURCE_KIND !== 'release', base: pins.node, source: revision, release: pkg.version, harness, harnessVersion: pins.harnesses[harness], nodeVersion: process.version, bunVersion, bunImage: pins.bun.image, osPackages, packages }) + '\n');
// Build-only pnpm timestamps are not runtime inputs and prevent reproducible layers.
for (const path of ['/opt/harness/node_modules/.modules.yaml', '/opt/harness/node_modules/.pnpm-workspace-state-v1.json']) await rm(path, { force: true });
