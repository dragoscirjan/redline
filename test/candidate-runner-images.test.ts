import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  CANDIDATE_ACKNOWLEDGEMENT, CANDIDATE_FILES, CANDIDATE_WORKFLOW,
  candidateImage, candidateNativeVersion, collectCandidateImages, inspectCandidateGate, materializeCandidateContext, parseCandidateApiResponse, parseCandidatePlatforms, parseCandidateTree,
  validateCandidateDispatch, validateCandidateDockerfile, validateCandidateEnvironment, validateCandidatePullRequest,
  type CandidateDispatch,
} from '../src/candidate-runner-images.js';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const DIGEST = `sha256:${'c'.repeat(64)}`;
const execute = promisify(execFile);

function dispatch(overrides: Partial<CandidateDispatch> = {}): CandidateDispatch {
  return {
    event: 'workflow_dispatch', ref: 'refs/heads/main',
    workflowRef: `dragoscirjan/redline/${CANDIDATE_WORKFLOW}@refs/heads/main`, workflowSha: OTHER_SHA,
    repository: 'dragoscirjan/redline', owner: 'dragoscirjan', ownerType: 'User', privateRepository: 'false',
    actor: 'dragoscirjan', triggeringActor: 'dragoscirjan',
    inputs: { source_sha: SHA, pull_request: '76', approval: CANDIDATE_ACKNOWLEDGEMENT },
    ...overrides,
  };
}
function pr(head = SHA): unknown {
  return { number: 76, state: 'open', merged: false,
    head: { sha: head, repo: { full_name: 'dragoscirjan/redline' } },
    base: { ref: 'main', repo: { full_name: 'dragoscirjan/redline' } },
  };
}
function environment(): Record<string, unknown> {
  return { name: 'candidate-images',
    protection_rules: [{ type: 'required_reviewers', prevent_self_review: false,
      reviewers: [{ type: 'User', reviewer: { login: 'dragoscirjan' } }],
    }], deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  };
}
function policies(): unknown { return { total_count: 1, branch_policies: [{ name: 'main', type: 'branch' }] }; }
function tree(overrides: Record<string, string> = {}): Buffer {
  return Buffer.from(CANDIDATE_FILES.map((path) => overrides[path] ?? `100644 blob ${SHA} 4\t${path}`).join('\0') + '\0');
}

function fakeSource(): { tree: Buffer; blobs: Map<string, Buffer> } {
  const blobs = new Map<string, Buffer>();
  const rows = CANDIDATE_FILES.map((path) => {
    const dockerfile = path.includes('/pi-runner/') ? 'ARG PI_VERSION=0.87.1\nFROM scratch\n' : 'ARG OPENCODE_VERSION=1.18.32\nFROM scratch\n';
    const bytes = Buffer.from(path.endsWith('/Dockerfile') ? dockerfile : `data: ${path}\n`);
    const id = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    blobs.set(id, bytes);
    return `100644 blob ${id} ${bytes.length}\t${path}`;
  });
  return { tree: Buffer.from(rows.join('\0') + '\0'), blobs };
}

test('validates only owner-dispatched exact source SHA on captured main workflow', () => {
  const result = validateCandidateDispatch(dispatch());
  assert.equal(result.sourceSha, SHA);
  assert.equal(result.workflowSha, OTHER_SHA);
  assert.equal(result.pullRequest, 76);
});

test('rejects foreign actors, reruns, refs, definitions, events and unsupported repositories', () => {
  for (const value of [
    { actor: 'contributor' }, { triggeringActor: 'contributor' }, { event: 'pull_request' },
    { ref: 'refs/heads/attack' }, { workflowRef: 'dragoscirjan/redline/.github/workflows/evil.yml@refs/heads/main' },
    { workflowSha: 'main' }, { ownerType: 'Organization' }, { privateRepository: 'true' },
    { repository: 'evil/redline' }, { owner: '../evil' },
  ]) assert.throws(() => validateCandidateDispatch(dispatch(value)));
});

test('rejects injection, malformed IDs, missing acknowledgement and unknown input fields', () => {
  for (const inputs of [
    { source_sha: `${SHA}\ncommand`, pull_request: '76', approval: CANDIDATE_ACKNOWLEDGEMENT },
    { source_sha: SHA, pull_request: '76; command', approval: CANDIDATE_ACKNOWLEDGEMENT },
    { source_sha: SHA, pull_request: '0', approval: CANDIDATE_ACKNOWLEDGEMENT },
    { source_sha: SHA, pull_request: '76', approval: 'yes' },
    { source_sha: SHA, pull_request: '76', approval: CANDIDATE_ACKNOWLEDGEMENT, command: 'touch marker' },
    null, [],
  ]) assert.throws(() => validateCandidateDispatch(dispatch({ inputs })));
});

test('requires same-repository open source head at initial and post-approval checks', () => {
  const request = validateCandidateDispatch(dispatch());
  validateCandidatePullRequest(request, pr());
  for (const value of [
    { ...pr() as object, state: 'closed' }, { ...pr() as object, merged: true },
    { ...pr() as object, number: 77 }, { ...pr() as object, head: { sha: SHA, repo: { full_name: 'fork/redline' } } },
    { ...pr() as object, base: { ref: 'dev', repo: { full_name: 'dragoscirjan/redline' } } }, pr(OTHER_SHA),
  ]) assert.throws(() => validateCandidatePullRequest(request, value));
});

test('requires exposed owner/self-review/environment fields and exact main branch restriction', () => {
  validateCandidateEnvironment('dragoscirjan', environment(), policies());
  for (const env of [
    {}, { ...environment(), name: 'other' }, { ...environment(), protection_rules: [] },
    { ...environment(), protection_rules: [{ type: 'required_reviewers', reviewers: [] }] },
    { ...environment(), protection_rules: [{ type: 'required_reviewers', prevent_self_review: true,
      reviewers: [{ type: 'User', reviewer: { login: 'dragoscirjan' } }] }] },
    { ...environment(), protection_rules: [{ type: 'required_reviewers', prevent_self_review: false,
      reviewers: [{ type: 'User', reviewer: { login: 'contributor' } }] }] },
    { ...environment(), deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } },
  ]) assert.throws(() => validateCandidateEnvironment('dragoscirjan', env, policies()));
  for (const branches of [
    {}, { total_count: 2, branch_policies: [{ name: 'main', type: 'branch' }] },
    { total_count: 1, branch_policies: [{ name: '*', type: 'branch' }] },
    { total_count: 1, branch_policies: [{ name: 'main', type: 'tag' }] },
    { total_count: 1, branch_policies: [{ name: 'main' }] },
  ]) assert.throws(() => validateCandidateEnvironment('dragoscirjan', environment(), branches));
});

test('post-approval head movement never replaces the SHA-bound source or skips environment rechecks', async () => {
  const request = validateCandidateDispatch(dispatch());
  let head = SHA;
  const calls: string[] = [];
  const reader = async (path: string): Promise<unknown> => {
    calls.push(path);
    return path.includes('/pulls/') ? pr(head) : path.includes('/deployment-branch-policies') ? policies() : environment();
  };
  const before = await inspectCandidateGate(request, reader, true);
  assert.equal(before.sourceSha, SHA);
  head = OTHER_SHA;
  await assert.rejects(inspectCandidateGate(request, reader, true));
  calls.length = 0;
  const during = await inspectCandidateGate(request, reader, false);
  assert.equal(during.sourceSha, SHA);
  assert.equal(during.currentHeadRequired, false);
  assert.equal(calls.length, 2);
  assert.equal(calls.some((path) => path.includes('/pulls/')), false);
  assert.doesNotMatch(JSON.stringify(during), /admin-bypass-disabled|source-reviewed/u);
  await assert.rejects(inspectCandidateGate(request, async (path) => path.includes('/deployment-branch-policies') ? policies() : {}, false));
});

test('native version metadata requires a single fixed reviewed ARG', () => {
  assert.equal(candidateNativeVersion('ARG PI_VERSION=0.87.1\n', 'pi'), '0.87.1');
  assert.throws(() => candidateNativeVersion('ARG PI_VERSION=$VERSION\n', 'pi'));
  assert.throws(() => candidateNativeVersion('ARG PI_VERSION=0.87.1\nARG PI_VERSION=0.88.0\n', 'pi'));
});

test('validates fixed Git object allowlist before reading or materializing content', () => {
  assert.equal(parseCandidateTree(tree()).length, 10);
  const path = CANDIDATE_FILES[0];
  for (const replacement of [
    `120000 blob ${SHA} 4\t${path}`, `160000 commit ${SHA} -\t${path}`,
    `100644 blob ${SHA} 4\t../../host-secret`, `100644 blob ${SHA} 4\t/root/.docker/config.json`,
    `100644 blob ${SHA} 4\tpackages/base-runner/.env`, `100644 blob ${SHA} 2097153\t${path}`,
    `100644 blob bad 4\t${path}`, `100644 blob ${SHA} 4\t${path}\ncommand`,
  ]) assert.throws(() => parseCandidateTree(tree({ [path]: replacement })));
  assert.throws(() => parseCandidateTree(tree().subarray(0, -1)));
  assert.throws(() => parseCandidateTree(Buffer.alloc(32769)));
});

test('rejects Dockerfile COPY/ADD extensions, variables, globs and ONBUILD outside supported syntax', () => {
  validateCandidateDockerfile('FROM scratch\nCOPY packages/runner-bootstrap/bootstrap.js /opt/redline/bootstrap.js\n');
  for (const value of [
    'COPY /root/.docker/config.json /tmp/secret', 'ADD https://evil.test/thing /tmp/thing',
    'COPY ["packages/runner-bootstrap/bootstrap.js", "/tmp/bootstrap"]',
    'COPY --from=other /secret /tmp/secret', 'COPY $PATH /tmp/source',
    'COPY packages/* /tmp/source', 'ONBUILD COPY /root/.docker /tmp/secret',
  ]) assert.throws(() => validateCandidateDockerfile(value));
});

test('materializes only verified blob bytes with no imported scripts or local ignored context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'redline-candidate-context-'));
  try {
    const source = fakeSource();
    const request = validateCandidateDispatch(dispatch());
    const entries = parseCandidateTree(source.tree);
    const proof = await materializeCandidateContext(request, root, entries, async (id) => source.blobs.get(id) as Buffer);
    assert.equal(proof.sourceSha, SHA);
    assert.equal(proof.files.length, 10);
    assert.deepEqual(await readdir(root), ['packages']);
    for (const entry of entries) assert.deepEqual(await readFile(join(root, entry.path)), source.blobs.get(entry.objectId));
    assert.doesNotMatch(JSON.stringify(proof), /credential-sentinel|GITHUB_TOKEN/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects wrong blob bytes before creating any source file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'redline-candidate-context-'));
  try {
    const source = fakeSource();
    await assert.rejects(materializeCandidateContext(validateCandidateDispatch(dispatch()), root, parseCandidateTree(source.tree), async () => Buffer.from('evil')));
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('candidate inspection binds digest authority and both unique architecture descriptors', () => {
  assert.match(candidateImage('dragoscirjan', 'pi', DIGEST), /^ghcr\.io\/dragoscirjan\/redline-pi-runner@sha256:/u);
  assert.throws(() => candidateImage('dragoscirjan', 'pi', 'candidate-tag'));
  const index = { schemaVersion: 2, manifests: [
    { digest: DIGEST, platform: { os: 'linux', architecture: 'amd64' } },
    { digest: `sha256:${'d'.repeat(64)}`, platform: { os: 'linux', architecture: 'arm64' } },
  ] };
  assert.equal(parseCandidatePlatforms(index).length, 2);
  assert.throws(() => parseCandidatePlatforms({ ...index, manifests: index.manifests.slice(0, 1) }));
  assert.throws(() => parseCandidatePlatforms({ ...index, manifests: [index.manifests[0], index.manifests[0]] }));
});

test('tag movement cannot replace captured digest authority and partial verification stays explicit', async () => {
  const request = validateCandidateDispatch(dispatch());
  let mutableTagDigest = DIGEST;
  const inspected: string[] = [];
  const results = await collectCandidateImages(request, { base: DIGEST, pi: DIGEST }, async (backend, digest) => {
    inspected.push(candidateImage(request.owner, backend, digest));
    mutableTagDigest = `sha256:${'e'.repeat(64)}`;
    if (backend === 'pi') throw new Error('fake private provider error must not enter provenance');
    return { image: candidateImage(request.owner, backend, digest) };
  });
  assert.notEqual(mutableTagDigest, DIGEST);
  assert.equal(inspected.length, 2);
  assert.equal(inspected.every((image) => image.endsWith(`@${DIGEST}`)), true);
  assert.deepEqual(Object.keys(results.images), ['base']);
  assert.deepEqual(Object.keys(results.capturedDigests), ['base', 'pi']);
  assert.deepEqual(results.errors, ['candidate pi verification failed']);
  assert.doesNotMatch(JSON.stringify(results), /private provider error/u);
  let called = false;
  const malformed = await collectCandidateImages(request, { base: 'latest; command' }, async () => { called = true; return {}; });
  assert.equal(called, false);
  assert.deepEqual(malformed.capturedDigests, {});
});

test('API transport is bounded and rejects malformed, invalid UTF-8 and credential-bearing errors', async () => {
  assert.deepEqual(await parseCandidateApiResponse(new Response('{"ok":true}')), { ok: true });
  for (const response of [
    new Response('candidate-secret-sentinel', { status: 401 }),
    new Response('candidate-secret-sentinel'),
    new Response(Buffer.from([0xff])), new Response(' '.repeat(1024 * 1024 + 1)),
  ]) await assert.rejects(parseCandidateApiResponse(response), (error: unknown) => {
    assert.doesNotMatch(String(error), /candidate-secret-sentinel/u);
    return true;
  });
});

test('materialization rejects malformed exported entry data before invoking any reader', async () => {
  const source = fakeSource();
  const entries = parseCandidateTree(source.tree);
  let read = false;
  const bad = entries.map((entry, index) => index === 0 ? { ...entry, objectId: '--filters' } : entry);
  await assert.rejects(materializeCandidateContext(validateCandidateDispatch(dispatch()), '/unused', bad, async () => { read = true; return Buffer.alloc(0); }));
  assert.equal(read, false);
});

test('workflow has no PR trigger, source checkout, dependency install, production tag or pruning', async () => {
  const yaml = await readFile('.github/workflows/candidate-runner-images.yml', 'utf8');
  assert.match(yaml, /permissions: \{\}/u);
  assert.doesNotMatch(yaml, /(?:^|\n)  (?:pull_request|push):|pnpm install|npm (?:install|ci)|checkout[^\n]*source_sha|:latest\b|--method DELETE|package-delete|source_sha \}\}\n          persist/u);
  assert.match(yaml, /environment: candidate-images/u);
  assert.equal(yaml.match(/packages: write/gu)?.length, 1);
  assert.equal(yaml.match(/platforms: linux\/amd64,linux\/arm64/gu)?.length, 3);
  assert.equal(yaml.match(/ref: \$\{\{ github\.workflow_sha \}\}/gu)?.length, 2);
  assert.match(yaml, /github\.triggering_actor == github\.repository_owner/u);
  assert.equal(yaml.match(/candidate-runner-images\.ts gate/gu)?.length, 3);
  assert.match(yaml, /RUNNER_BASE=\$\{\{ steps\.reference\.outputs\.base_reference \}\}/u);
  assert.match(yaml, /buildkitd-flags: --oci-worker-gc=true/u);
  const uses = yaml.split('\n').filter((line) => /uses: /u.test(line));
  for (const line of uses) assert.match(line, /@[0-9a-f]{40}\b/u);
});

test('standalone trusted TS validator needs no project install and never echoes bad input secrets', async () => {
  const sentinel = 'candidate-credential-sentinel';
  await assert.rejects(execute(process.execPath, ['--experimental-strip-types', 'src/candidate-runner-images.ts', 'preflight'], {
    env: { PATH: process.env.PATH, CANDIDATE_INPUTS: JSON.stringify({ source_sha: sentinel }) },
  }), (error: unknown) => {
    const value = error as { stdout: string; stderr: string };
    assert.doesNotMatch(value.stdout + value.stderr, new RegExp(sentinel, 'u'));
    assert.match(value.stderr, /candidate operation failed/u);
    return true;
  });
});
