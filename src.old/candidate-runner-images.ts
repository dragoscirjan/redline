import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CANDIDATE_WORKFLOW = '.github/workflows/candidate-runner-images.yml';
export const CANDIDATE_ENVIRONMENT = 'candidate-images';
export const CANDIDATE_ACKNOWLEDGEMENT = 'publish-reviewed-sha-and-confirm-admin-bypass-disabled';
export const CANDIDATE_FILES = Object.freeze([
  'packages/base-runner/Dockerfile',
  'packages/base-runner/mcp/package.json',
  'packages/base-runner/mcp/package-lock.json',
  'packages/base-runner/mcp/codegraphcontext-requirements.txt',
  'packages/runner-bootstrap/bootstrap.js',
  'packages/pi-runner/Dockerfile',
  'packages/pi-runner/pi/settings.json',
  'packages/opencode-runner/Dockerfile',
  'packages/opencode-runner/opencode/opencode.json',
  'packages/opencode-runner/opencode/redline-report-plugin.js',
] as const);
const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CONTEXT_BYTES = 16 * 1024 * 1024;

export interface CandidateDispatch {
  event: string;
  ref: string;
  workflowRef: string;
  workflowSha: string;
  repository: string;
  owner: string;
  ownerType: string;
  privateRepository: string;
  actor: string;
  triggeringActor: string;
  inputs: unknown;
}
export interface CandidateRequest {
  repository: string;
  owner: string;
  actor: string;
  sourceSha: string;
  workflowSha: string;
  pullRequest: number;
}
export interface CandidateBlob {
  path: string;
  mode: '100644' | '100755';
  objectId: string;
  bytes: number;
}
export interface CandidateFileProof extends CandidateBlob { sha256: string }
export interface CandidateSourceProof {
  version: 1;
  sourceSha: string;
  files: CandidateFileProof[];
  expectedVersions: { pi: string; opencode: string };
}
export interface CandidatePlatform { architecture: 'amd64' | 'arm64'; digest: string }

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function record(value: unknown): Record<string, unknown> {
  requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value), 'candidate metadata must be an object');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  requireCondition(typeof value === 'string', 'candidate metadata string is missing');
  return value;
}

export function validateCandidateDispatch(snapshot: CandidateDispatch): CandidateRequest {
  const repository = snapshot.repository.toLowerCase();
  const owner = snapshot.owner.toLowerCase();
  requireCondition(/^[a-z0-9](?:[a-z0-9-]{0,38})$/u.test(owner) && repository === `${owner}/redline`, 'unsupported candidate repository');
  requireCondition(snapshot.ownerType === 'User' && snapshot.privateRepository === 'false', 'candidate publication supports public personal repositories only');
  requireCondition(snapshot.event === 'workflow_dispatch' && snapshot.ref === 'refs/heads/main', 'candidate publication requires main manual dispatch');
  requireCondition(snapshot.workflowRef === `${repository}/${CANDIDATE_WORKFLOW}@refs/heads/main` && SHA.test(snapshot.workflowSha), 'candidate workflow revision is invalid');
  requireCondition(snapshot.actor.toLowerCase() === owner && snapshot.triggeringActor.toLowerCase() === owner, 'candidate dispatch and rerun require the owner');
  const inputs = record(snapshot.inputs);
  requireCondition(Object.keys(inputs).length === 3 && Object.keys(inputs).every((key) => ['source_sha', 'pull_request', 'approval'].includes(key)), 'candidate inputs contain unsupported fields');
  const sourceSha = text(inputs.source_sha);
  const pullRequest = text(inputs.pull_request);
  requireCondition(SHA.test(sourceSha) && /^[1-9][0-9]{0,8}$/u.test(pullRequest), 'candidate source SHA or pull request is invalid');
  requireCondition(inputs.approval === CANDIDATE_ACKNOWLEDGEMENT, 'candidate source review and manual checklist acknowledgement is required');
  return { repository, owner, actor: owner, sourceSha, workflowSha: snapshot.workflowSha, pullRequest: Number(pullRequest) };
}

export function validateCandidatePullRequest(request: CandidateRequest, value: unknown): void {
  const pr = record(value);
  const head = record(pr.head);
  const base = record(pr.base);
  requireCondition(pr.number === request.pullRequest && pr.state === 'open' && pr.merged === false, 'candidate pull request must be open and unmerged');
  requireCondition(record(head.repo).full_name === request.repository && record(base.repo).full_name === request.repository && base.ref === 'main', 'candidate pull request must use the same repository and main base');
  requireCondition(head.sha === request.sourceSha, 'candidate head does not match the approved source SHA');
}

export function validateCandidateEnvironment(owner: string, environment: unknown, branches: unknown): void {
  const env = record(environment);
  requireCondition(env.name === CANDIDATE_ENVIRONMENT && Array.isArray(env.protection_rules) && env.protection_rules.length <= 8, 'candidate environment protection is missing');
  const rules = env.protection_rules.map(record);
  requireCondition(rules.every((rule) => ['required_reviewers', 'wait_timer', 'branch_policy'].includes(text(rule.type))), 'unsupported candidate environment protection rule');
  requireCondition(new Set(rules.map((rule) => rule.type)).size === rules.length, 'candidate environment has duplicate protection rules');
  const reviews = rules.filter((rule) => rule.type === 'required_reviewers');
  requireCondition(reviews.length === 1, 'candidate environment must have exactly one reviewer rule');
  const rule = reviews[0] as Record<string, unknown>;
  requireCondition(rule.prevent_self_review === false && Array.isArray(rule.reviewers) && rule.reviewers.length === 1, 'candidate environment must allow the single owner to approve');
  const reviewer = record(rule.reviewers[0]);
  requireCondition(reviewer.type === 'User' && record(reviewer.reviewer).login === owner, 'candidate environment reviewer must be the owner');
  const policy = record(env.deployment_branch_policy);
  requireCondition(policy.protected_branches === false && policy.custom_branch_policies === true, 'candidate environment requires exact custom main restriction');
  const listing = record(branches);
  requireCondition(listing.total_count === 1 && Array.isArray(listing.branch_policies) && listing.branch_policies.length === 1, 'candidate environment branch policy is ambiguous');
  const branch = record(listing.branch_policies[0]);
  requireCondition(branch.name === 'main' && branch.type === 'branch', 'candidate environment must restrict deployments to main only');
}

export function parseCandidateTree(bytes: Uint8Array): CandidateBlob[] {
  requireCondition(bytes.byteLength <= 32 * 1024, 'candidate tree metadata exceeds its byte limit');
  const data = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  requireCondition(data.endsWith('\0'), 'candidate tree metadata is truncated');
  const entries = data.slice(0, -1).split('\0');
  requireCondition(entries.length === CANDIDATE_FILES.length, 'candidate tree must contain all fixed runner files');
  const found = new Set<string>();
  let total = 0;
  return entries.map((entry) => {
    const match = /^(100644|100755) blob ([0-9a-f]{40}) +([0-9]+)\t([^\0\r\n]+)$/u.exec(entry);
    requireCondition(match, 'candidate tree contains unsupported modes or metadata');
    const path = match[4] as string;
    requireCondition((CANDIDATE_FILES as readonly string[]).includes(path) && !found.has(path), 'candidate tree contains unsafe or duplicate paths');
    found.add(path);
    const size = Number(match[3]);
    requireCondition(Number.isSafeInteger(size) && size <= MAX_FILE_BYTES, 'candidate blob exceeds its byte limit');
    total += size;
    requireCondition(total <= MAX_CONTEXT_BYTES, 'candidate context exceeds its byte limit');
    return { path, mode: match[1] as CandidateBlob['mode'], objectId: match[2] as string, bytes: size };
  });
}

export function validateCandidateDockerfile(value: string): void {
  for (const line of value.split(/\r?\n/u)) {
    const trimmed = line.trim();
    requireCondition(!/^ONBUILD\b/iu.test(trimmed), 'candidate Dockerfile ONBUILD is unsupported');
    if (!/^(COPY|ADD)\b/iu.test(trimmed)) continue;
    const match = /^COPY\s+([a-zA-Z0-9._/-]+)\s+(\/[a-zA-Z0-9._/-]+)\s*$/iu.exec(trimmed);
    requireCondition(match && (CANDIDATE_FILES as readonly string[]).includes(match[1] as string), 'candidate Dockerfile COPY or ADD is outside the fixed supported syntax');
  }
}

export function candidateImage(owner: string, backend: 'base' | 'pi' | 'opencode', digest: string): string {
  requireCondition(/^[a-z0-9][a-z0-9-]{0,38}$/u.test(owner) && DIGEST.test(digest), 'candidate image digest is invalid');
  return `ghcr.io/${owner}/redline-${backend === 'base' ? 'base' : backend}-runner@${digest}`;
}

export function parseCandidatePlatforms(value: unknown): CandidatePlatform[] {
  const index = record(value);
  requireCondition(index.schemaVersion === 2 && Array.isArray(index.manifests) && index.manifests.length <= 8, 'candidate image must have a bounded multi-platform index');
  const result: CandidatePlatform[] = [];
  for (const item of index.manifests) {
    const descriptor = record(item);
    const platform = record(descriptor.platform);
    requireCondition(DIGEST.test(text(descriptor.digest)), 'candidate platform digest is invalid');
    if (platform.os === 'unknown' && platform.architecture === 'unknown') continue;
    requireCondition(platform.os === 'linux' && (platform.architecture === 'amd64' || platform.architecture === 'arm64'), 'candidate image has an unsupported platform');
    result.push({ architecture: platform.architecture, digest: text(descriptor.digest) });
  }
  requireCondition(result.length === 2 && new Set(result.map((entry) => entry.architecture)).size === 2, 'candidate image must contain both unique architectures');
  return result;
}

function command(binary: 'git' | 'docker', args: string[], limit = MAX_RESPONSE_BYTES): Buffer {
  // Source values never become shell text, and failed subprocess output can
  // contain source-controlled text. Report only the fixed command category.
  try {
    return execFileSync(binary, args, {
      timeout: 120_000, maxBuffer: limit, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
  } catch {
    throw new Error(`candidate ${binary} operation failed`);
  }
}

function validateCandidateEntries(entries: CandidateBlob[]): void {
  requireCondition(entries.length === CANDIDATE_FILES.length, 'candidate context file count is invalid');
  const paths = new Set<string>();
  let total = 0;
  for (const entry of entries) {
    requireCondition((CANDIDATE_FILES as readonly string[]).includes(entry.path) && !paths.has(entry.path), 'candidate context path is unsafe or duplicate');
    paths.add(entry.path);
    requireCondition(['100644', '100755'].includes(entry.mode) && SHA.test(entry.objectId), 'candidate context object metadata is invalid');
    requireCondition(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && entry.bytes <= MAX_FILE_BYTES, 'candidate context object size is invalid');
    total += entry.bytes;
  }
  requireCondition(total <= MAX_CONTEXT_BYTES, 'candidate context exceeds its byte limit');
}

export function candidateNativeVersion(dockerfile: string, backend: 'pi' | 'opencode'): string {
  const name = backend === 'pi' ? 'PI_VERSION' : 'OPENCODE_VERSION';
  const matches = [...dockerfile.matchAll(new RegExp(`^ARG ${name}=([0-9]+\\.[0-9]+\\.[0-9]+)$`, 'gm'))];
  requireCondition(matches.length === 1, 'candidate native version must be a single fixed ARG');
  return (matches[0] as RegExpMatchArray)[1] as string;
}

export async function materializeCandidateContext(
  request: CandidateRequest,
  root: string,
  entries: CandidateBlob[],
  readBlob: (objectId: string) => Promise<Uint8Array>,
): Promise<CandidateSourceProof> {
  validateCandidateEntries(entries);
  const files: CandidateFileProof[] = [];
  const expectedVersions = { pi: '', opencode: '' };
  // Validate every object and Dockerfile before creating any source paths.
  const blobs = new Map<string, Uint8Array>();
  for (const entry of entries) {
    requireCondition((CANDIDATE_FILES as readonly string[]).includes(entry.path), 'candidate materialization path is not allowlisted');
    const bytes = await readBlob(entry.objectId);
    requireCondition(bytes.byteLength === entry.bytes && bytes.byteLength <= MAX_FILE_BYTES, 'candidate blob size changed');
    const objectId = createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
    requireCondition(objectId === entry.objectId, 'candidate Git blob identity does not match');
    if (entry.path.endsWith('/Dockerfile')) {
      const dockerfile = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      validateCandidateDockerfile(dockerfile);
      if (entry.path === 'packages/pi-runner/Dockerfile') expectedVersions.pi = candidateNativeVersion(dockerfile, 'pi');
      if (entry.path === 'packages/opencode-runner/Dockerfile') expectedVersions.opencode = candidateNativeVersion(dockerfile, 'opencode');
    }
    blobs.set(entry.path, bytes);
    files.push({ ...entry, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  requireCondition(files.length === CANDIDATE_FILES.length && blobs.size === CANDIDATE_FILES.length, 'candidate context has missing or duplicate files');
  for (const entry of entries) {
    const path = join(root, entry.path);
    await mkdir(resolve(path, '..'), { recursive: true, mode: 0o755 });
    await writeFile(path, blobs.get(entry.path) as Uint8Array, { flag: 'wx', mode: entry.mode === '100755' ? 0o755 : 0o644 });
  }
  return { version: 1, sourceSha: request.sourceSha, files, expectedVersions };
}

export async function parseCandidateApiResponse(response: Response): Promise<unknown> {
  requireCondition(response.ok, `candidate API request failed with HTTP ${response.status}`);
  requireCondition(response.body, 'candidate API response is empty');
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      requireCondition(size <= MAX_RESPONSE_BYTES, 'candidate API response exceeds its byte limit');
      parts.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))) as unknown; }
  catch { throw new Error('candidate API response is malformed'); }
}
async function api(path: string, token: string): Promise<unknown> {
  return parseCandidateApiResponse(await fetch(`https://api.github.com/${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  }));
}
export async function inspectCandidateGate(
  request: CandidateRequest,
  readApi: (path: string) => Promise<unknown>,
  requireCurrentHead: boolean,
): Promise<{ checkedAt: string; sourceSha: string; currentHeadRequired: boolean; apiVerified: string[] }> {
  const prefix = `repos/${request.repository}`;
  if (requireCurrentHead) validateCandidatePullRequest(request, await readApi(`${prefix}/pulls/${request.pullRequest}`));
  const [env, policies] = await Promise.all([
    readApi(`${prefix}/environments/${CANDIDATE_ENVIRONMENT}`),
    readApi(`${prefix}/environments/${CANDIDATE_ENVIRONMENT}/deployment-branch-policies?per_page=100`),
  ]);
  validateCandidateEnvironment(request.owner, env, policies);
  return {
    checkedAt: new Date().toISOString(), sourceSha: request.sourceSha, currentHeadRequired: requireCurrentHead,
    apiVerified: ['existing-environment', 'owner-only-required-reviewer', 'self-review-allowed', 'exact-main-branch'],
  };
}
async function checkGate(request: CandidateRequest, token: string, requireCurrentHead: boolean): Promise<void> {
  const proof = await inspectCandidateGate(request, (path) => api(path, token), requireCurrentHead);
  await appendFile(join(process.env.RUNNER_TEMP as string, 'candidate-gate-checks.jsonl'), JSON.stringify(proof) + '\n', { mode: 0o600 });
}

function requestFromEnvironment(): CandidateRequest {
  const env = process.env;
  return validateCandidateDispatch({
    event: env.GITHUB_EVENT_NAME ?? '', ref: env.GITHUB_REF ?? '',
    workflowRef: env.CANDIDATE_WORKFLOW_REF ?? '', workflowSha: env.CANDIDATE_WORKFLOW_SHA ?? '',
    repository: env.GITHUB_REPOSITORY ?? '', owner: env.GITHUB_REPOSITORY_OWNER ?? '',
    ownerType: env.CANDIDATE_OWNER_TYPE ?? '', privateRepository: env.CANDIDATE_REPOSITORY_PRIVATE ?? '',
    actor: env.GITHUB_ACTOR ?? '', triggeringActor: env.GITHUB_TRIGGERING_ACTOR ?? '',
    inputs: JSON.parse(env.CANDIDATE_INPUTS ?? '{}') as unknown,
  });
}
async function output(values: Record<string, string>): Promise<void> {
  const destination = process.env.GITHUB_OUTPUT;
  requireCondition(destination, 'candidate output destination is missing');
  for (const [key, value] of Object.entries(values)) {
    requireCondition(/^[a-z_]+$/u.test(key) && !/[\r\n\0]/u.test(value), 'candidate output is invalid');
    await appendFile(destination, `${key}=${value}\n`);
  }
}

async function verifyImage(request: CandidateRequest, backend: 'base' | 'pi' | 'opencode', digest: string, proof: CandidateSourceProof): Promise<unknown> {
  const image = candidateImage(request.owner, backend, digest);
  const platforms = parseCandidatePlatforms(JSON.parse(command('docker', ['buildx', 'imagetools', 'inspect', '--raw', image]).toString('utf8')) as unknown);
  const expected = proof.files.find((file) => file.path === 'packages/runner-bootstrap/bootstrap.js')?.sha256;
  requireCondition(expected, 'candidate bootstrap proof is missing');
  const checks: Array<Record<string, unknown>> = [];
  for (const platform of platforms) {
    const selected = candidateImage(request.owner, backend, platform.digest);
    command('docker', ['pull', '--platform', `linux/${platform.architecture}`, selected]);
    const temp = await mkdtemp(join(process.env.RUNNER_TEMP ?? '/tmp', 'candidate-inspection-'));
    let container: string | undefined;
    const probe = `redline-candidate-version-${randomUUID()}`;
    let probeAttempted = false;
    try {
      container = command('docker', ['create', '--platform', `linux/${platform.architecture}`, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', selected]).toString('utf8').trim();
      requireCondition(/^[0-9a-f]{64}$/u.test(container), 'candidate inspection container identity is invalid');
      const copied = join(temp, 'bootstrap.js');
      command('docker', ['cp', `${container}:/opt/redline/bootstrap.js`, copied]);
      const info = await lstat(copied);
      requireCondition(info.isFile() && !info.isSymbolicLink() && info.size <= MAX_FILE_BYTES, 'candidate copied bootstrap is unsafe');
      const actual = createHash('sha256').update(await readFile(copied)).digest('hex');
      requireCondition(actual === expected, 'candidate bootstrap differs from approved source');
      let version: string | null = null;
      if (backend !== 'base') {
        probeAttempted = true;
        version = command('docker', ['run', '--name', probe, '--platform', `linux/${platform.architecture}`, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '768m', '--cpus', '1', '--user', '10001:10001', '--tmpfs', '/tmp/redline:rw,nosuid,nodev,size=67108864,mode=1777', '--entrypoint', `/usr/local/bin/${backend}`, selected, '--version'], 4096).toString('utf8').trim();
        requireCondition(version === proof.expectedVersions[backend], 'candidate native version differs from reviewed source');
      }
      checks.push({ ...platform, bootstrapSha256: actual, version });
    } finally {
      try {
        if (probeAttempted) command('docker', ['rm', '--force', probe]);
      } finally {
        try {
          if (container && /^[0-9a-f]{64}$/u.test(container)) command('docker', ['rm', '--force', container]);
        } finally { await rm(temp, { recursive: true, force: true }); }
      }
    }
  }
  return { image, platforms: checks };
}

export async function collectCandidateImages(
  request: CandidateRequest,
  digests: Partial<Record<'base' | 'pi' | 'opencode', string | undefined>>,
  verify: (backend: 'base' | 'pi' | 'opencode', digest: string) => Promise<unknown>,
): Promise<{ images: Record<string, unknown>; capturedDigests: Record<string, string>; errors: string[] }> {
  const images: Record<string, unknown> = {};
  const capturedDigests: Record<string, string> = {};
  const errors: string[] = [];
  for (const backend of ['base', 'pi', 'opencode'] as const) {
    const digest = digests[backend];
    if (!digest) continue;
    try {
      capturedDigests[backend] = candidateImage(request.owner, backend, digest);
      images[backend] = await verify(backend, digest);
    } catch { errors.push(`candidate ${backend} verification failed`); }
  }
  return { images, capturedDigests, errors };
}

async function cli(): Promise<void> {
  requireCondition(process.argv.length === 3, 'candidate CLI requires one fixed operation');
  const mode = process.argv[2];
  requireCondition(['preflight', 'prepare', 'gate', 'base-reference', 'collect'].includes(mode ?? ''), 'candidate CLI operation is unsupported');
  const request = requestFromEnvironment();
  const token = process.env.GITHUB_TOKEN;
  requireCondition(token, 'candidate API authentication is missing');
  const temp = process.env.RUNNER_TEMP;
  requireCondition(temp && resolve(temp) === temp, 'candidate private temporary directory is missing');
  const proofPath = join(temp, 'candidate-source-proof.json');
  if (mode === 'preflight' || mode === 'prepare' || mode === 'gate') {
    await checkGate(request, token, mode !== 'gate');
    if (mode === 'preflight') {
      await output({ source_sha: request.sourceSha, pull_request: String(request.pullRequest), owner: request.owner });
      return;
    }
    if (mode === 'gate') return;
    command('git', ['fetch', '--no-tags', '--depth=1', 'origin', request.sourceSha]);
    const entries = parseCandidateTree(command('git', ['ls-tree', '-r', '-z', '-l', request.sourceSha, '--', ...CANDIDATE_FILES], 32 * 1024));
    const root = await mkdtemp(join(temp, 'candidate-context-'));
    const proof = await materializeCandidateContext(request, root, entries, async (id) => command('git', ['cat-file', 'blob', id], MAX_FILE_BYTES));
    await writeFile(proofPath, JSON.stringify(proof), { mode: 0o600, flag: 'wx' });
    await output({ context: root });
    return;
  }
  if (mode === 'base-reference') {
    await output({ base_reference: candidateImage(request.owner, 'base', process.env.CANDIDATE_BASE_DIGEST ?? '') });
    return;
  }
  const proof = JSON.parse(await readFile(proofPath, 'utf8')) as CandidateSourceProof;
  requireCondition(proof.version === 1 && proof.sourceSha === request.sourceSha && proof.files.length === CANDIDATE_FILES.length, 'candidate source proof is invalid');
  const gateBytes = await readFile(join(temp, 'candidate-gate-checks.jsonl'));
  requireCondition(gateBytes.byteLength <= 32 * 1024, 'candidate gate history exceeds its byte limit');
  const gateChecks = gateBytes.toString('utf8').trim().split('\n').map((line) => JSON.parse(line) as unknown);
  const { images, capturedDigests, errors } = await collectCandidateImages(request, {
    base: process.env.CANDIDATE_BASE_DIGEST,
    pi: process.env.CANDIDATE_PI_DIGEST,
    opencode: process.env.CANDIDATE_OPENCODE_DIGEST,
  }, (backend, digest) => verifyImage(request, backend, digest, proof));
  const complete = Object.keys(images).length === 3 && errors.length === 0 && process.env.CANDIDATE_JOB_STATUS === 'success';
  const provenance = {
    version: 1, sourceSha: request.sourceSha, workflowSha: request.workflowSha, actor: request.actor,
    pullRequest: request.pullRequest, authorization: 'immutable-approved-source-sha', source: proof,
    checkedAt: new Date().toISOString(), gateChecks, capturedDigests, images, errors, status: complete ? 'verified' : 'incomplete',
    manualAttestations: ['source-reviewed-by-owner', 'admin-bypass-disabled'],
    limitations: ['Tag names are mutable locators.', 'PR head may have moved after approval.', 'Uncaptured partial publication may exist.', 'Native model integration and live review are not proven.'],
  };
  await writeFile(join(temp, 'candidate-provenance.json'), JSON.stringify(provenance, null, 2) + '\n', { mode: 0o600 });
  requireCondition(complete, 'candidate publication or verification is incomplete; inspect bounded provenance');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void cli().catch(() => {
    // Never log raw fetch, Git, Docker, or parsing exceptions with credentials.
    console.error('candidate operation failed; publication may be incomplete; no production pins were updated');
    process.exitCode = 1;
  });
}
