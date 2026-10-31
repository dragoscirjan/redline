import { parseArgs } from 'node:util';
import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from './server.ts';
import { localExecutor } from './local.ts';

export const RPC_HELP = `Usage: redline rpc [--once] [trusted review settings]

JSON-RPC 2.0 over Content-Length framed UTF-8 stdio. Redline protocol 1.0.
Initialize, start/query/cancel reviews, page results, then shutdown.
Stdout contains frames only. Repository source selection arrives via requests.
Credentials stay in the existing trusted user config or environment.
--once accepts one review and drains accepted work on stdin EOF.
Without --once, stdin EOF cancels active work.
All clients can query completed results before shutdown/EOF.
No HTTP listener, editor extension, or forge publication.
See docs/stdio-protocol.md for schemas, limits, errors and recovery.
`;
const SETTINGS = ['config', 'harness', 'provider', 'endpoint', 'model', 'auth', 'indexing',
  'indexing-provider', 'index-executable', 'index-runtime', 'max-output-tokens', 'timeout',
  'run-timeout', 'retries', 'concurrency', 'finding-scope', 'reuse', 'scheduling', 'head-context', 'model-protocol', 'fail-on'] as const;
export async function main(
  args: readonly string[] = process.argv.slice(3),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (args.length === 1 && args[0] === '--help') { process.stdout.write(RPC_HELP); return 0; }
  let once: boolean;
  const startup: string[] = [];
  try {
    if (args.length > 64 || Buffer.byteLength(args.join('')) > 64 * 1024) throw new Error('limit');
    const values: Record<string, unknown> = parseArgs({ args: [...args], strict: true, allowPositionals: false,
      options: { once: { type: 'boolean' }, ...Object.fromEntries(SETTINGS.map(key => [key, { type: 'string' as const }])) },
    }).values;
    once = values.once === true;
    for (const key of SETTINGS) {
      const value = values[key];
      if (typeof value === 'string') startup.push('--' + key, key === 'config' || key === 'index-executable' || key === 'index-runtime' ? resolve(value) : value);
    }
  } catch { process.stderr.write('redline rpc: invalid startup settings; use --help. Credentials are not arguments.\n'); return 2; }
  const controller = new AbortController();
  const interrupt = (): void => controller.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    let outputFailed = false;
    // process.stdout can synchronously block the event loop on Windows pipes.
    const output = createWriteStream('', { fd: 1, autoClose: false });
    const code = await serve({ input: process.stdin, output, once,
      execute: localExecutor(startup, { ...env }, process.cwd()), signal: controller.signal,
      onOutputFailure: () => { outputFailed = true; } });
    if (outputFailed) {
      // An OS pipe write can remain pending after destroy(). Review cleanup has settled.
      const diagnostic = createWriteStream('', { fd: 2, autoClose: false });
      diagnostic.on('error', () => {});
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 1000);
        diagnostic.write('redline rpc: output unavailable\n', () => { clearTimeout(timer); resolve(); });
      });
      // A blocked native fs write can also prevent Node's graceful thread-pool shutdown.
      // Only this owned process is terminated, after all review work has settled.
      process.kill(process.pid, 'SIGKILL');
      return code || 1;
    }
    return code;
  } catch { process.stderr.write('redline rpc: session failed\n'); return 1; }
  finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}
