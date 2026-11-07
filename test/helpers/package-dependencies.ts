/** Install the real production dependency closure without registry access or checkout symlinks. */
import { execaSync } from 'execa';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { npmArguments } from './npm.ts';

interface Metadata { readonly name: string; readonly dependencies?: Readonly<Record<string, string>> }

export function installOfflineDependencies(project: string, installation: string, archives: string, env: NodeJS.ProcessEnv): void {
  const metadata: Metadata = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'));
  const pending = Object.keys(metadata.dependencies ?? {}).map(name => ({ name, from: project }));
  const directories = new Set<string>();
  while (pending.length > 0) {
    const dependency = pending.pop();
    if (dependency === undefined) break;
    // Import-only exports need not support require.resolve at the package root.
    const search = createRequire(join(dependency.from, 'package.json')).resolve.paths(dependency.name) ?? [];
    const location = search.map(path => join(path, dependency.name)).find(path => existsSync(join(path, 'package.json')));
    if (location === undefined) throw new Error('Cannot locate production dependency metadata');
    const directory = realpathSync(location);
    const manifest: Metadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    if (directories.has(directory)) continue;
    directories.add(directory);
    for (const name of Object.keys(manifest.dependencies ?? {})) pending.push({ name, from: directory });
  }
  if (directories.size === 0) return;
  const packed: { filename: string }[] = JSON.parse(execaSync(process.execPath,
    npmArguments(['pack', ...directories, '--ignore-scripts', '--json', '--pack-destination', archives]), {
      cwd: project, env, extendEnv: false, stripFinalNewline: false, maxBuffer: 1024 * 1024,
    }).stdout);
  execaSync(process.execPath, npmArguments(['install', '--prefix', installation, '--ignore-scripts', '--offline',
    '--no-audit', '--no-fund', '--package-lock=false', ...packed.map(archive => join(archives, archive.filename))]), {
    env, extendEnv: false, maxBuffer: 1024 * 1024,
  });
}
