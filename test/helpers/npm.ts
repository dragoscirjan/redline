/** Invoke npm's installed JS entrypoint without a Windows cmd.exe shim. */
import { existsSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';

export function npmArguments(args: readonly string[]): string[] {
  const directory = dirname(process.execPath);
  const candidates = [
    join(directory, 'node_modules/npm/bin/npm-cli.js'),
    resolve(directory, '../lib/node_modules/npm/bin/npm-cli.js'),
  ];
  if (process.platform !== 'win32') {
    for (const path of (process.env.PATH ?? '').split(delimiter)) {
      const executable = join(path, 'npm');
      if (existsSync(executable)) candidates.push(realpathSync(executable));
    }
  }
  const cli = candidates.find((path) => existsSync(path) && path.endsWith('npm-cli.js'));
  if (cli === undefined) throw new Error('Node installation must include npm for package-install verification');
  return [cli, ...args];
}
