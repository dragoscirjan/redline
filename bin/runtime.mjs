/** Select a packaged runtime. No TypeScript loader hooks or runtime compilation. */
import { access } from 'node:fs/promises';
import { constants } from 'node:os';

async function delegate(runtime) {
  // Keep the Node-version guard usable before loading dependencies with newer engine requirements.
  const { execa } = await import('execa');
  const child = execa(runtime, process.argv.slice(1), {
    stdio: 'inherit', windowsHide: true, reject: false, buffer: false,
    preferLocal: false, shell: false, verbose: 'none',
  });
  const interrupt = () => { child.kill('SIGINT'); };
  const terminate = () => { child.kill('SIGTERM'); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    const result = await child;
    if (result.exitCode === undefined && result.signal === undefined) {
      process.stderr.write(`redline: selected runtime ${runtime} is unavailable\n`);
      return 2;
    }
    return result.exitCode ?? 128 + (constants.signals[result.signal] ?? 0);
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  }
}

export async function run(entry) {
  const runtime = process.env.REDLINE_ENV || 'node';
  if (runtime !== 'node' && runtime !== 'bun') {
    process.stderr.write('redline: REDLINE_ENV must be node or bun\n');
    process.exitCode = 2;
    return;
  }
  const actual = process.versions.bun === undefined ? 'node' : 'bun';
  if (runtime !== actual) {
    // npm generates Node-based command shims. Re-exec Bun without a shell when selected.
    process.exitCode = await delegate(runtime);
    return;
  }
  if (runtime === 'node' && Number(process.versions.node.split('.')[0]) < 24) {
    process.stderr.write('redline requires Node.js 24 or newer\n');
    process.exitCode = 2;
    return;
  }
  const target = new URL(runtime === 'node' ? entry.replace('../src/', '../dist/').replace(/\.ts$/u, '.js') : entry, import.meta.url);
  try { await access(target); }
  catch {
    process.stderr.write(runtime === 'node'
      ? 'redline: compiled entrypoint is missing; run pnpm run build before using this checkout\n'
      : 'redline: packaged TypeScript entrypoint is missing\n');
    process.exitCode = 2;
    return;
  }
  // The selector belongs to the launcher, not the strict review environment contract.
  const env = { ...process.env };
  delete env.REDLINE_ENV;
  const { main } = await import(target.href);
  process.exitCode = await main(undefined, env);
}
