#!/usr/bin/env node
/** Trusted composite-action entry point. Production verification stays gated
 * until an independently judged live quality and latency run passes. */
import { pathToFileURL } from 'node:url';
import { main } from '../review/cli.ts';
import { createActionFollowUpExecutor } from './follow-up.ts';

export function requireActionFollowUpConfig(env: NodeJS.ProcessEnv): {
  provider: 'cgc' | 'gitnexus'; runnerTemp: string; reviewDirectory: string;
} {
  const provider = env.CODE_INDEX_PROVIDER;
  const runnerTemp = env.RUNNER_TEMP;
  const reviewDirectory = env.REDLINE_REVIEW_DIR;
  if ((provider !== 'cgc' && provider !== 'gitnexus') || !runnerTemp || !reviewDirectory) {
    throw new Error('action-owned verification requires a pinned provider and review bundle');
  }
  return { provider, runnerTemp, reviewDirectory };
}

async function run(): Promise<number> {
  if (process.env.CODE_INDEX_VERIFICATION_ENABLED !== 'true') return main();
  const config = requireActionFollowUpConfig(process.env);
  const followUpExecutor = createActionFollowUpExecutor({ ...config, actionRoot: process.cwd() });
  return main([], process.env, { reviewOptions: { verifyCandidates: true, followUpExecutor } });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void run().then((code) => { process.exitCode = code; }).catch(() => {
    process.stderr.write('redline-review: action-owned verification unavailable\n');
    process.exitCode = 1;
  });
}
