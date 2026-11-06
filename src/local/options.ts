import { Command } from 'commander';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { requireCapability } from '../application/capabilities.ts';
import { parseOutputTokens } from '../harness-executor/output-budget.ts';
import { DEFAULT_REVIEW_RETRIES, parseReviewRetries } from '../review/retries.ts';
import { parseReviewEnvironment, type ReviewEnvironment } from '../review/environment.ts';
import { executable, GitCommand, gitEnvironment, inside, repositoryBoundary } from './process.ts';

export interface LocalOptions {
  readonly repository: string;
  readonly output: string | undefined;
  readonly stateDirectory: string;
  readonly reuse: 'enabled' | 'disabled';
  readonly base: string;
  readonly target: { readonly kind: 'revision'; readonly head: string; readonly comparison: 'merge-base' | 'direct' }
    | { readonly kind: 'worktree'; readonly mode: 'staged' | 'unstaged' | 'all'; readonly untracked: boolean };
  readonly reporters: readonly string[];
  readonly color: 'auto' | 'always' | 'never';
  readonly progress: 'auto' | 'always' | 'never';
  readonly indexing: {
    readonly mode: 'enabled' | 'disabled' | 'required';
    readonly provider: 'cgc' | 'gitnexus';
    readonly executable: string | undefined;
    readonly runtime: string | undefined;
    readonly artifact: string | undefined;
    readonly repository: string | undefined;
  };
  readonly failOn: 'none' | 'findings' | 'high' | 'critical';
  readonly environment: ReviewEnvironment;
}

export class UsageError extends Error {}

export function createReviewCommand(command: Command = new Command('review')): Command {
  return command
    .description('Review local Git changes. With no target, review staged and unstaged tracked changes against HEAD.')
    .allowExcessArguments(false)
    .exitOverride()
    // Commander errors can contain raw argument values. Report trusted classifications instead.
    .configureOutput({ writeErr: () => {}, outputError: () => {} })
    // Defaults are resolved after parsing so flags do not mask environment or user configuration.
    .optionsGroup('Repository and target:')
    // Review another checkout without requiring the caller to change its working directory.
    .option('--repository <path>', 'Repository path; default current directory')
    // Select the source-control adapter explicitly. Only Git is implemented;
    // jj and mercurial are reserved capability IDs and currently fail.
    .option('--vcs <git|jj|mercurial>', 'Version control; default git; other values reserved')
    // Supply the history reference for the review diff instead of always using HEAD.
    // Merge-base comparison and unstaged capture derive their effective base from it.
    .option('--base <rev>', 'Base revision; default HEAD')
    // Review a committed revision rather than including local staged or unstaged edits.
    .option('--head <rev>', 'Committed revision comparison; mutually exclusive with --worktree')
    // Choose branch changes since the common ancestor, or compare the exact base and head trees.
    // This applies only to committed targets.
    .option('--comparison <merge-base|direct>', 'Revision comparison; default merge-base; requires --head')
    // Review staged content, unstaged edits, or both without modifying the user's index or commits.
    // Unstaged mode compares working files with the captured index.
    .option('--worktree <staged|unstaged|all>', 'Working-tree target; default all; mutually exclusive with --head')
    // Opt new, non-ignored files into a working-tree review before they are added to Git.
    // Exclude them by default so unrelated local files do not enter the review.
    .option('--untracked <exclude|include>', 'Untracked files; default exclude; worktree only')

    .optionsGroup('Configuration:')
    // Load reusable trusted user settings instead of repeating flags for each run.
    // The file must be outside the reviewed repository so repository content cannot configure execution.
    .option('--config <path>', 'Trusted user JSON; never repository configuration')

    .optionsGroup('Harness and model:')
    // Choose the program that executes review prompts. Pi and OpenCode use model services;
    // echo is a deterministic harness for tests and smoke runs, not an AI reviewer.
    .option('--harness <pi|opencode|echo>', 'Review harness; default pi; binaries installed separately')
    // Choose the model-service configuration and the matching entry in the credential map.
    // This is separate from the harness and the code indexer.
    .option('--provider <id>', 'Model provider')
    // Direct model requests to the configured service or a compatible local endpoint.
    // Credentials cannot be embedded in the URL.
    .option('--endpoint <url>', 'Model endpoint without credentials, query parameters, or fragments')
    // Choose the model identifier passed to the selected harness and provider.
    .option('--model <id>', 'Model identifier')
    // Allow an explicitly credential-less endpoint with auth=none.
    // Never accept an API key on the command line; credentials come from environment or trusted config.
    .option('--auth <none>', 'Credential-less endpoint; otherwise use provider-keyed REDLINE_MODEL_AUTH JSON')
    // Opt into explicit Pi/OpenRouter JSON request controls instead of the compatible request mode.
    // The special mode requires Pi with OpenRouter and does not silently fall back.
    .option('--model-protocol <compatible|openrouter-json>', 'Model request protocol; default compatible; explicit Pi/OpenRouter controls')

    .optionsGroup('Harness tools and context:')
    // Choose whether to prepare indexed related-source context or allow file-only review.
    // Required mode stops before review if a reviewed file lacks validated related spans.
    .option('--indexing <enabled|disabled|required>', 'Indexed context; default enabled; required rejects file-only fallback')
    // Choose which external code indexer supplies relationships, independently of the model provider.
    // Redline resolves related source from the capture rather than trusting graph text.
    .option('--indexing-provider <cgc|gitnexus>', 'Indexer provider; default cgc; installed separately')
    // Use a specific trusted indexer program instead of automatic tool discovery.
    // Repository-local programs are rejected; this does not install an indexer.
    .option('--index-executable <path>', 'Trusted existing indexer override')
    // Choose the Python interpreter for code-context preparation when automatic discovery is unsuitable.
    // This is not the runtime for Redline or the review harness.
    .option('--index-runtime <path>', 'Trusted Python helper runtime override')
    // Import an existing context artifact instead of preparing one through the local indexer.
    // The artifact must pass repository and revision checks before it can supply context.
    .option('--code-context <path>', 'Import an existing revision-matched context artifact')
    // Set the expected owner/name identity used to prepare or validate context artifacts.
    // This identifies the artifact namespace; it does not choose the checkout to review.
    .option('--code-context-repository <id>', 'Expected artifact namespace; default local identity')
    // Allow bounded static import-related source candidates from the captured head without an indexer.
    // This controls static context separately from the indexed-context setting.
    .option('--head-context <enabled|disabled>', 'Bounded static head import candidates; default enabled')

    .optionsGroup('Execution limits and reuse:')
    // Bound each model call's generated-token allowance independently of its time limit.
    // This is not an input-context limit or a control for disabling reasoning.
    .option('--max-output-tokens <count>', 'Per model call; Pi default 16384; range 1024..262144')
    // Bound the initial attempt for one reviewed file so a stalled harness cannot block it indefinitely.
    // Timed-out retries can receive longer attempts, but remain inside the run deadline.
    .option('--timeout <duration>', 'Initial per-file attempt; default 4m')
    // Allow additional file-review attempts after retryable failures, invalid output, or inadequate excerpts.
    // This counts review attempts, not a provider's internal HTTP retries.
    .option('--retries <count>', `Additional attempts, 0..10; default ${DEFAULT_REVIEW_RETRIES}; timeouts add 2m; total deadline never grows`)
    // Bound context preparation and review execution with one deadline shared by all files and retries.
    // The timer starts after harness preflight and output-directory creation.
    .option('--run-timeout <duration>', 'Whole review deadline; default 10m')
    // Limit simultaneous file reviews to control model-service load and local resource use.
    .option('--concurrency <1..8>', 'Concurrent file reviews; default 4')
    // Choose the order in which files compete for bounded workers and the run deadline.
    // Largest-first starts large files first; mixed alternates large and small files.
    .option('--scheduling <largest-first|mixed>', 'File scheduling; default largest-first; mixed alternates size extremes')
    // Avoid repeating model work when cached per-file results still pass exact reuse validation.
    // Disabled mode requests fresh execution rather than accepting those cached results.
    .option('--reuse <enabled|disabled>', 'Revalidate exact cached results; default enabled')

    .optionsGroup('Output and finding policy:')
    // Select the review output adapter. Only cli works today;
    // the repeatable interface and forge IDs do not yet enable other destinations.
    .option('--reporter <id>', 'Repeatable; cli implemented; github|forgejo|gitea|gitlab|bitbucket reserved',
      (value: string, previous: readonly string[] = []) => [...previous, value])
    // Keep the captured source, bundle, reports, and run status at a caller-chosen location.
    // The directory must be new and outside the reviewed checkout to avoid overwriting data.
    .option('--output <path>', 'New output directory; default user state directory')
    // Control terminal presentation for interactive output or redirected logs.
    // This does not change findings or review policy.
    .option('--color <auto|always|never>', 'Terminal color; default auto; NO_COLOR disables colors')
    // Keep the live progress display when explicitly requested through redirected output.
    .option('--progress <auto|always|never>', 'Live progress; default auto; always keeps the bar through tee')
    // Choose whether the review policy permits only defects or also risks.
    // This changes what the model is asked to report, not just the process exit status.
    .option('--finding-scope <defects|defects-and-risks>', 'Finding policy; default defects')
    // Make validated findings at the selected severity fail automation even when review completed.
    // This changes the exit policy, not which findings are retained; incomplete reviews still fail.
    .option('--fail-on <none|findings|high|critical>', 'Finding exit policy; default none; incomplete reviews still fail')
    .optionsGroup('Options:')
    .addHelpText('after', `
Model defaults can use REDLINE_MODEL_CONFIG JSON. Non-secret flags override
REDLINE_* environment values, which override trusted user configuration.
Exit: 0 success, 1 incomplete/failure, 2 usage, 3 finding policy,
      4 unavailable capability, 5 reporter failure, 130 interrupted.
`);
}

export function reviewOptionValues(command: Command): Record<string, unknown> {
  const values = command.opts<Record<string, unknown>>();
  return Object.fromEntries(command.options.map((option) => [option.name(), values[option.attributeName()]]));
}

const KEYS = createReviewCommand().options.map((option) => option.name())
  .filter((key) => key !== 'config' && key !== 'reporter');

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
    const command = createReviewCommand().helpOption(false);
    command.parse([...args], { from: 'user' });
    values = reviewOptionValues(command);
  } catch { throw new UsageError('invalid arguments; use redline review --help (credentials are not command-line options)'); }
  return resolveLocalOptions(values, env, cwd, signal);
}

export async function resolveLocalOptions(values: Readonly<Record<string, unknown>>, env: NodeJS.ProcessEnv, cwd: string, signal: AbortSignal): Promise<LocalOptions> {
  signal.throwIfAborted();
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
  const get = (key: string, fallback: string): string => {
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
  const tokenInput = flag('max-output-tokens') ?? env.REDLINE_MAX_OUTPUT_TOKENS ?? defaults['max-output-tokens'];
  let maxOutputTokens: number | undefined;
  try { maxOutputTokens = parseOutputTokens(tokenInput === undefined ? undefined : String(tokenInput)); }
  catch (error) { throw new UsageError(error instanceof Error ? error.message : 'invalid max-output-tokens'); }
  let retries: number;
  try { retries = parseReviewRetries(get('retries', String(DEFAULT_REVIEW_RETRIES))); }
  catch (error) { throw new UsageError(error instanceof Error ? error.message : 'invalid retries'); }
  const parsed = parseReviewEnvironment({
    REDLINE_HARNESS: harness, REDLINE_REVIEW_DIR: '/prepared/bundle', REDLINE_SOURCE_DIR: '/prepared/source',
    REDLINE_OUTPUT_DIR: output === undefined ? stateDirectory : resolve(cwd, String(output)),
    REDLINE_MODEL_CONFIG: JSON.stringify(model), ...(authValue === undefined ? {} : { REDLINE_MODEL_AUTH: authValue }),
    REDLINE_TIMEOUT: get('timeout', '4m'), REDLINE_RUN_TIMEOUT: get('run-timeout', '10m'),
    ...(maxOutputTokens === undefined ? {} : { REDLINE_MAX_OUTPUT_TOKENS: String(maxOutputTokens) }),
    REDLINE_REVIEW_CONCURRENCY: get('concurrency', '4'), REDLINE_FINDING_SCOPE: get('finding-scope', 'defects'),
  });
  if (parsed.review === undefined) throw new UsageError('review configuration is incomplete');
  const optional = (key: string): string | undefined => {
    const value = flag(key) ?? env[`REDLINE_${key.toUpperCase().replaceAll('-', '_')}`] ?? defaults[key];
    return value === undefined ? undefined : get(key, '');
  };
  const artifact = optional('code-context');
  const indexExecutable = optional('index-executable');
  const indexRuntime = optional('index-runtime');
  const contextRepository = optional('code-context-repository');
  const indexMode = choice(get('indexing', 'enabled'), ['enabled', 'disabled', 'required'], 'indexing');
  if (artifact !== undefined && (indexMode === 'disabled' || indexExecutable !== undefined)) throw new UsageError('imported context conflicts with disabled indexing or an indexer executable');
  if (contextRepository !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(contextRepository)) throw new UsageError('invalid code-context repository namespace');
  const base = get('base', 'HEAD');
  const target: LocalOptions['target'] = head === undefined
    ? { kind: 'worktree', mode, untracked: untracked === 'include' }
    : { kind: 'revision', head: get('head', String(head)), comparison: choice(get('comparison', 'merge-base'), ['merge-base', 'direct'], 'comparison') };
  return {
    reuse: choice(get('reuse', 'enabled'), ['enabled', 'disabled'], 'reuse'),
    repository, stateDirectory: resolve(cwd, stateDirectory), output: output === undefined ? undefined : resolve(cwd, String(output)), base, target,
    indexing: { mode: indexMode, provider: choice(get('indexing-provider', 'cgc'), ['cgc', 'gitnexus'], 'indexing-provider'),
      artifact: artifact === undefined ? undefined : resolve(cwd, artifact),
      executable: indexExecutable === undefined ? undefined : resolve(cwd, indexExecutable),
      runtime: indexRuntime === undefined ? undefined : resolve(cwd, indexRuntime), repository: contextRepository },
    progress: choice(get('progress', 'auto'), ['auto', 'always', 'never'], 'progress'),
    reporters, color: choice(get('color', 'auto'), ['auto', 'always', 'never'], 'color'), failOn: choice(get('fail-on', 'none'), ['none', 'findings', 'high', 'critical'], 'fail-on'), environment: { ...parsed.review,
      retries,
      scheduling: choice(get('scheduling', 'largest-first'), ['largest-first', 'mixed'] as const, 'scheduling'),
      headContext: choice(get('head-context', 'enabled'), ['enabled', 'disabled'], 'head-context') === 'enabled',
      modelProtocol: choice(get('model-protocol', 'compatible'), ['compatible', 'openrouter-json'] as const, 'model-protocol'),
    },
  };
}
