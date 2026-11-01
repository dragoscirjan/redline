import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { packCandidate } from '../src/release/npm-registry.ts';
import { verifyOfflineCandidate } from '../src/release/candidate-smoke.ts';

it('checks exact packed npm bytes offline through revision, worktree and RPC entry points before publication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'redline-release-candidate-test-'));
  try {
    const source = fileURLToPath(new URL('../', import.meta.url));
    const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    const packed = await packCandidate(source, directory);
    const proof = await verifyOfflineCandidate(join(directory, packed.filename), pkg.version);
    expect(proof.checks).toEqual(['offline-install-without-scripts', 'cli-help-and-version', 'committed-review-echo', 'worktree-review-echo', 'rpc-initialize-once']);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);
