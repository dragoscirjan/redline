/** Pack the staged package and its production dependency closure without registry access or checkout symlinks. */
import { execaSync } from 'execa';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { npmArguments } from './npm.ts';

interface Metadata { readonly name: string; readonly dependencies?: Readonly<Record<string, string>> }

interface PackedPackage {
  readonly name: string;
  readonly filename: string;
  readonly files: readonly { readonly path: string }[];
}

/** Archive the staged distribution and real dependency closure together; never fetch packages or link the checkout. */
export function packOfflinePackage(project: string, staged: string, archives: string, env: NodeJS.ProcessEnv): readonly PackedPackage[] {
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
  // One npm startup for the entire closure matters on native Windows runners.
  return JSON.parse(execaSync(process.execPath,
    npmArguments(['pack', staged, ...directories, '--ignore-scripts', '--json', '--pack-destination', archives]), {
      cwd: project, env, extendEnv: false, stripFinalNewline: false, maxBuffer: 1024 * 1024,
    }).stdout);
}
