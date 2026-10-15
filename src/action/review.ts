#!/usr/bin/env node
/** Trusted composite-action entry point. Production verification stays gated
 * until an independently judged live quality and latency run passes. */
import { main } from '../review/cli.js';
import { createActionFollowUpExecutor } from './follow-up.js';

async function run(): Promise<number> {
  if (process.env.CODE_INDEX_VERIFICATION_ENABLED !== 'true') return main();
  const provider = process.env.CODE_INDEX_PROVIDER;
  const runnerTemp = process.env.RUNNER_TEMP;
  const reviewDirectory = process.env.REDLINE_REVIEW_DIR;
  if ((provider !== 'cgc' && provider !== 'gitnexus') ||
      runnerTemp === undefined || reviewDirectory === undefined) {
    throw new Error('action-owned verification requires a pinned provider and review bundle');
  }
  const followUpExecutor = createActionFollowUpExecutor({
    provider, runnerTemp, reviewDirectory, actionRoot: process.cwd(),
  });
  return main([], process.env, { reviewOptions: { verifyCandidates: true, followUpExecutor } });
}

void run().then((code) => { process.exitCode = code; }).catch(() => {
  process.stderr.write('redline-review: action-owned verification unavailable\n');
  process.exitCode = 1;
});
