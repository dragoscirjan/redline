import { parseArgs } from 'node:util';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { requireCapability } from '../application/capabilities.ts';
import { parseReviewEnvironment, type ReviewEnvironment } from '../review/environment.ts';
import { executable, GitCommand, gitEnvironment, inside, repositoryBoundary } from './process.ts';

const KEYS = ['repository', 'output', 'vcs', 'base', 'head', 'worktree', 'comparison', 'untracked', 'harness',
  'provider', 'endpoint', 'model', 'auth', 'timeout', 'run-timeout', 'concurrency', 'finding-scope', 'fail-on'] as const;
type Key = (typeof KEYS)[number];
export interface LocalOptions {
  readonly repository: string;
  readonly output: string | undefined;
  readonly stateDirectory: string;
  readonly base: string;
  readonly target: { readonly kind: 'revision'; readonly head: string; readonly comparison: 'merge-base' | 'direct' }
    | { readonly kind: 'worktree'; readonly mode: 'staged' | 'unstaged' | 'all'; readonly untracked: boolean };
  readonly reporters: readonly string[];
  readonly failOn: 'none' | 'findings' | 'high' | 'critical';
  readonly environment: ReviewEnvironment;
}

export class UsageError extends Error {}

export const HELP = `Usage: redline review [options]

No target: review staged and unstaged tracked changes against HEAD.
  --repository PATH                  Current directory by default
  --vcs git|jj|mercurial              git implemented; other values reserved
  --base REV                         HEAD by default
  --head REV                         Committed revision comparison
  --comparison merge-base|direct     merge-base by default (revisions only)
  --worktree staged|unstaged|all      Mutually exclusive with --head
  --untracked exclude|include        exclude by default (worktree only)
  --reporter ID                      Repeatable; cli implemented
                                    github|forgejo|gitea|gitlab|bitbucket reserved
  --output PATH                      New directory; default user state directory
  --config PATH                      Trusted user JSON; never repository config
  --harness pi|opencode|echo          pi by default; binaries installed separately
  --provider ID --endpoint URL --model ID
  --auth none                        Credential-less endpoint; otherwise use
                                    REDLINE_MODEL_AUTH provider-keyed JSON
  --timeout DURATION                 Per file; default 4m
  --run-timeout DURATION             Whole review; default 10m
  --concurrency 1..8                 Default 4
  --finding-scope defects|defects-and-risks
  --fail-on none|findings|high|critical  Default none; incomplete reviews still fail
  --help | --version

Model defaults can use REDLINE_MODEL_CONFIG JSON. Non-secret flags override
REDLINE_* environment values, which override trusted user configuration.
Exit: 0 success, 1 incomplete/failure, 2 usage, 3 finding policy,
      4 unavailable capability, 5 reporter failure, 130 interrupted.
`;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function choice<T extends string>(value: string, allowed: readonly T[], name: string): T {
  if (!(allowed as readonly string[]).includes(value)) throw new UsageError(`invalid ${name}; choose ${allowed.join('|')}`);
  return value as T;
}

async function config(path: string, required: boolean, repository: string): Promise<Record<string, unknown>> {
  const canonical = await realpath(path).catch((error: NodeJS.ErrnoException) => {
    if (!required && error.code === 'ENOENT') return undefined;
    throw new UsageError('cannot read trusted user configuration');
  });
  if (canonical === undefined) return {};
  if (inside(repository, canonical)) throw new UsageError('user configuration must be outside the reviewed repository');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 64 * 1024) throw new UsageError('user configuration must be a bounded regular file');
    let value: unknown;
    try { value = JSON.parse(await handle.readFile('utf8')); } catch { throw new UsageError('invalid user configuration JSON'); }
    if (!object(value)) throw new UsageError('user configuration must be an object');
    const allowed: readonly string[] = [...KEYS.filter((key) => key !== 'repository'), 'reporter', 'model-config', 'model-auth'];
    if (Object.keys(value).some((key) => !allowed.includes(key))) throw new UsageError('unknown user configuration field');
    for (const key of KEYS) {
      if (value[key] !== undefined && typeof value[key] !== 'string') throw new UsageError('user configuration options must be strings');
    }
    if (value['model-auth'] !== undefined && process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
      throw new UsageError('credential-bearing user configuration must use mode 0600');
    }
    return value;
  } finally { await handle.close(); }
}

export async function parseLocalOptions(args: readonly string[], env: NodeJS.ProcessEnv, cwd: string, signal: AbortSignal = new AbortController().signal): Promise<LocalOptions> {
  signal.throwIfAborted();
  let values: Record<string, unknown>;
  try {
    values = parseArgs({ args: [...args], strict: true, allowPositionals: false,
      options: Object.fromEntries([
        ...KEYS.map((key) => [key, { type: 'string' as const }]),
        ['config', { type: 'string' as const }], ['reporter', { type: 'string' as const, multiple: true }],
      ]),
    }).values;
  } catch { throw new UsageError('invalid arguments; use redline review --help (credentials are not command-line options)'); }
  const flag = (key: string): string | undefined => typeof values[key] === 'string' ? values[key] : undefined;
  // Reject known unsupported values even before reading configuration or discovering Git.
  const selectedVcs = flag('vcs') ?? env.REDLINE_VCS;
  if (selectedVcs !== undefined) requireCapability('vcs', selectedVcs);
  const reporterFlags = values.reporter;
  if (Array.isArray(reporterFlags)) for (const id of reporterFlags) {
    if (typeof id !== 'string') throw new UsageError('reporter must be a string');
    requireCapability('reporter', id);
  }
  if (reporterFlags === undefined && env.REDLINE_REPORTER !== undefined) {
    for (const id of env.REDLINE_REPORTER.split(',')) requireCapability('reporter', id);
  }
  const selectedRepository = await realpath(resolve(cwd, flag('repository') ?? env.REDLINE_REPOSITORY_PATH ?? '.'));
  const gitCommand = await executable('git', env.PATH ?? '', await repositoryBoundary(selectedRepository));
  const discovery = new GitCommand(gitCommand, selectedRepository, gitEnvironment(gitCommand, env), signal);
  const repository = await realpath((await discovery.run(['rev-parse', '--show-toplevel'])).toString('utf8').trim());
  const configPath = flag('config') ?? join(env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), '.config'), 'redline/config.json');
  const defaults = await config(resolve(cwd, configPath), flag('config') !== undefined, repository);
  const get = (key: Key, fallback: string): string => {
    const environmentKey = key === 'head' ? 'REDLINE_HEAD_REVISION' : key === 'harness' ? 'REDLINE_HARNESS'
      : key === 'concurrency' ? 'REDLINE_REVIEW_CONCURRENCY' : `REDLINE_${key.toUpperCase().replaceAll('-', '_')}`;
    const value = flag(key) ?? env[environmentKey] ?? defaults[key] ?? fallback;
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /\p{Cc}/u.test(value)) {
      throw new UsageError(`invalid ${key}`);
    }
    return value;
  };
  requireCapability('vcs', get('vcs', 'git'));
  const rawReporters = reporterFlags ?? env.REDLINE_REPORTER?.split(',') ?? defaults.reporter ?? ['cli'];
  const reporters = typeof rawReporters === 'string' ? [rawReporters] : rawReporters;
  if (!Array.isArray(reporters) || reporters.length === 0 || reporters.length > 6 || reporters.some((id) => typeof id !== 'string')) {
    throw new UsageError('reporter must be a bounded list of IDs');
  }
  for (const id of reporters) requireCapability('reporter', id);
  if (new Set(reporters).size !== reporters.length) throw new UsageError('duplicate reporter');
  const targetSelections = [
    { head: flag('head'), worktree: flag('worktree') },
    { head: env.REDLINE_HEAD_REVISION, worktree: env.REDLINE_WORKTREE },
    { head: defaults.head, worktree: defaults.worktree },
  ];
  const { head, worktree } = targetSelections.find((selection) => selection.head !== undefined || selection.worktree !== undefined) ?? {};
  if (head !== undefined && worktree !== undefined) throw new UsageError('--head and --worktree are mutually exclusive');
  if (head !== undefined && (flag('untracked') !== undefined || defaults.untracked !== undefined || env.REDLINE_UNTRACKED !== undefined)) {
    throw new UsageError('--untracked requires a working-tree target');
  }
  if (head === undefined && (flag('comparison') !== undefined || env.REDLINE_COMPARISON !== undefined || defaults.comparison !== undefined)) {
    throw new UsageError('--comparison requires --head');
  }
  const mode = choice(typeof worktree === 'string' ? worktree : 'all', ['staged', 'unstaged', 'all'], 'worktree');
  const untracked = choice(get('untracked', 'exclude'), ['exclude', 'include'], 'untracked');
  if (mode === 'staged' && untracked === 'include') throw new UsageError('untracked inclusion is incompatible with staged-only review');
  const harness = get('harness', 'pi');
  let model: Record<string, unknown> = {};
  const rawModel = env.REDLINE_MODEL_CONFIG ?? defaults['model-config'];
  if (rawModel !== undefined) {
    let parsed: unknown;
    try { parsed = typeof rawModel === 'string' ? JSON.parse(rawModel) : rawModel; } catch { throw new UsageError('invalid model-config JSON'); }
    if (!object(parsed)) throw new UsageError('invalid model-config');
    model = { ...parsed };
  }
  const echo = harness === 'echo';
  for (const key of ['provider', 'endpoint', 'model'] as const) {
    model[key] = get(key, typeof model[key] === 'string' ? model[key] : echo ? ({ provider: 'mock', endpoint: 'http://127.0.0.1:1/v1', model: 'echo' })[key] : '');
  }
  let endpoint: URL;
  try { endpoint = new URL(String(model.endpoint)); } catch { throw new UsageError('invalid model endpoint'); }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new UsageError('endpoint must not contain credentials, query parameters, or fragments');
  }
  const auth = flag('auth') ?? env.REDLINE_AUTH ?? defaults.auth ?? (echo ? 'none' : model.auth);
  if (auth !== undefined) model.auth = choice(String(auth), ['none'], 'auth');
  const authValue = env.REDLINE_MODEL_AUTH ?? (defaults['model-auth'] === undefined ? undefined : JSON.stringify(defaults['model-auth']));
  const stateDirectory = join(env.XDG_STATE_HOME ?? join(env.HOME ?? homedir(), '.local/state'), 'redline/reviews');
  const output = flag('output') ?? env.REDLINE_OUTPUT_DIR ?? defaults.output;
  const parsed = parseReviewEnvironment({
    REDLINE_HARNESS: harness, REDLINE_REVIEW_DIR: '/prepared/bundle', REDLINE_SOURCE_DIR: '/prepared/source',
    REDLINE_OUTPUT_DIR: output === undefined ? stateDirectory : resolve(cwd, String(output)),
    REDLINE_MODEL_CONFIG: JSON.stringify(model), ...(authValue === undefined ? {} : { REDLINE_MODEL_AUTH: authValue }),
    REDLINE_TIMEOUT: get('timeout', '4m'), REDLINE_RUN_TIMEOUT: get('run-timeout', '10m'),
    REDLINE_REVIEW_CONCURRENCY: get('concurrency', '4'), REDLINE_FINDING_SCOPE: get('finding-scope', 'defects'),
  });
  if (parsed.review === undefined) throw new UsageError('review configuration is incomplete');
  const base = get('base', 'HEAD');
  const target: LocalOptions['target'] = head === undefined
    ? { kind: 'worktree', mode, untracked: untracked === 'include' }
    : { kind: 'revision', head: get('head', String(head)), comparison: choice(get('comparison', 'merge-base'), ['merge-base', 'direct'], 'comparison') };
  return {
    repository, stateDirectory: resolve(cwd, stateDirectory), output: output === undefined ? undefined : resolve(cwd, String(output)), base, target,
    reporters, failOn: choice(get('fail-on', 'none'), ['none', 'findings', 'high', 'critical'], 'fail-on'), environment: parsed.review,
  };
}
