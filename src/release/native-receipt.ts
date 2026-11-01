import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileDigest } from '../harness-worker/build.ts';
import { record } from '../harness-worker/contract.ts';
import { inspectCandidate } from './oci.ts';

export async function checkNativeTests(path: string): Promise<number> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!record(value) || value.success !== true || value.numFailedTests !== 0 || value.numPendingTests !== 0
    || typeof value.numPassedTests !== 'number' || value.numPassedTests < 11 || !Array.isArray(value.testResults)) throw new Error('Native test proof is incomplete');
  const names: string[] = [];
  for (const result of value.testResults) {
    if (!record(result) || result.status !== 'passed' || !Array.isArray(result.assertionResults)) throw new Error('Native test proof failed');
    for (const assertion of result.assertionResults) {
      if (!record(assertion) || assertion.status !== 'passed' || typeof assertion.fullName !== 'string') throw new Error('Native test assertion did not pass');
      names.push(assertion.fullName);
    }
  }
  for (const h of ['pi', 'opencode']) for (const operation of ['reviews through the host broker', 'uses the same isolated executor through RPC',
    'preserves native retry ownership', 'treats authentication failure as nonretryable', 'cancels an active isolated model stream']) {
    if (!names.some(n => n.includes(h + ' ' + operation))) throw new Error('Required actual worker tests are missing');
  }
  if (!names.some(n => n.includes('enforces the same kernel, filesystem, environment and network profile')) || names.length !== value.numPassedTests) throw new Error('Required actual worker tests are missing');
  return value.numPassedTests;
}
export async function nativeReceipt(directory: string): Promise<void> {
  const build: unknown = JSON.parse(await readFile(join(directory, 'build-record.json'), 'utf8'));
  if (!record(build) || build.version !== 1 || build.development !== false || typeof build.source !== 'string' || !/^[a-f0-9]{40}$/u.test(build.source)
    || typeof build.release !== 'string' || !['linux/amd64', 'linux/arm64'].includes(String(build.platform)) || !Array.isArray(build.records) || build.records.length !== 2
    || (process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64') !== build.platform || process.platform !== 'linux') throw new Error('Native release build proof mismatch');
  const arch = build.platform === 'linux/amd64' ? 'amd64' : 'arm64';
  const runId = process.env.GITHUB_RUN_ID; const artifact = process.env.WORKER_ARTIFACT_NAME;
  if (runId === undefined || !/^[0-9]+$/u.test(runId) || artifact === undefined || !new RegExp(`^worker-native-${arch}-${runId}-attempt[0-9]+$`, 'u').test(artifact)) throw new Error('Native artifact identity unavailable');
  const tests = await checkNativeTests(join(directory, 'test-results.json'));
  const images: Record<string, unknown> = {};
  for (const h of ['pi', 'opencode']) {
    const values = build.records.filter(v => record(v) && v.harness === h); const value = values[0];
    if (values.length !== 1 || !record(value) || value.platform !== build.platform || value.archive !== `${h}-${arch}.oci.tar` || typeof value.reference !== 'string'
      || typeof value.archiveSha256 !== 'string' || await fileDigest(join(directory, value.archive)) !== value.archiveSha256) throw new Error('Native candidate artifact integrity mismatch');
    const candidate = await inspectCandidate(join(directory, value.archive), arch, value.reference);
    images[h] = { config: value.reference, manifest: candidate.descriptor.digest, archiveSha256: value.archiveSha256 };
  }
  await writeFile(join(directory, 'native-receipt.json'), JSON.stringify({ version: 1, kind: 'native-model-mock', source: build.source, release: build.release,
    runId, artifact, platform: build.platform, tests, images }, null, 2) + '\n');
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  nativeReceipt(process.argv[2] ?? '').catch(() => { process.stderr.write('Native worker receipt failed\n'); process.exitCode = 1; });
}
