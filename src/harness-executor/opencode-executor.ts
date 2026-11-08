/**
 * OpenCode harness executor.
 *
 * Runs one non-interactive `opencode run` process per prompt. Native CLI/Docker
 * merges request settings into normal global/local configuration and keeps
 * configured tools, MCPs, plugins and permissions. The selected key uses an
 * environment reference. Isolated Actions retain `--pure`, redirected HOME/XDG,
 * generated mode-0600 configuration and exact read-only tool permissions.
 */

import { prepareAnalysis, integrationServers, integrationToolNames, type PreparedAnalysis } from './analysis.ts';
import { outputCaptureBytes, validateOutputTokens } from './output-budget.ts';
import { nativeEnvironment, nativeToolEvidence, type NativeHarnessContext } from './native.ts';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isRecord,
  nodeProcessSpawner,
  runBoundedProcess,
  type BoundedRunResult,
  type ProcessSpawner,
} from './process-runner.ts';
import { classifyModelFailure, redactModelFailure } from './model-failure.ts';
import type {
  HarnessExecuteOptions,
  HarnessExecutor,
  HarnessOutputLine,
  HarnessPrompt,
  HarnessRun,
  HarnessSettings,
  PreparedHarness,
} from './types.ts';

export interface OpenCodeExecutorOptions {
  readonly native?: NativeHarnessContext | undefined;
  /** Executable override; defaults to the `opencode` found on PATH. */
  readonly command?: string | undefined;
  readonly spawner?: ProcessSpawner | undefined;
}

/** Agent name registered by the generated OpenCode configuration. */
export const OPENCODE_REVIEW_AGENT = 'redline-review' as const;

// Native diagnostics can include expanded configuration and credentials belonging to other providers.
const NATIVE_DIAGNOSTIC = 'OpenCode native diagnostic suppressed because it may contain configuration credentials.';

/**
 * Built-in OpenCode tool identifiers the generated agent disables. The
 * `skill` tool must be disabled explicitly; leaving it enabled leaks a tool
 * into the review session even with every other tool off.
 */
const DISABLED_TOOLS = [
  'bash',
  'edit',
  'glob',
  'grep',
  'list',
  'patch',
  'read',
  'skill',
  'task',
  'todoread',
  'todowrite',
  'webfetch',
  'write',
] as const;

export interface PreparedOpenCode extends PreparedHarness {
  readonly harness: 'opencode';
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly rootDirectory: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
  readonly native?: NativeHarnessContext;
  readonly retryOwnership?: 'caller' | undefined;
  readonly credential?: string | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly modelConfig: {
    readonly provider: string;
    readonly model: string;
    readonly options: Record<string, string>;
  };
}

/** Generate the isolated agent configuration with deny-by-default tools and only authorized analysis capabilities. */
function buildConfig(
  modelConfig: PreparedOpenCode['modelConfig'],
  systemPrompt: string,
  analysis?: PreparedAnalysis,
): string {
  const tools: Record<string, boolean> = { '*': false };
  for (const tool of DISABLED_TOOLS) tools[tool] = false;
  const permission: Record<string, string> = { '*': 'deny' };
  for (const name of integrationToolNames(analysis, 'opencode')) { tools[name] = true; permission[name] = 'allow'; }
  const config = {
    $schema: 'https://opencode.ai/config.json',
    mcp: integrationServers(analysis, 'opencode'),
    plugin: [],
    provider: {
      [modelConfig.provider]: {
        options: modelConfig.options,
        models: { [modelConfig.model]: {} },
      },
    },
    agent: {
      [OPENCODE_REVIEW_AGENT]: {
        prompt: systemPrompt,
        tools,
        permission,
      },
    },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Merge request settings into native configuration without replacing unrelated providers, plugins, tools, or permissions. */
function nativeConfig(state: PreparedOpenCode, prompt: HarnessPrompt): string {
  let base: unknown;
  try { base = JSON.parse(state.env['OPENCODE_CONFIG_CONTENT'] ?? '{}'); }
  catch { throw new Error('native OPENCODE_CONFIG_CONTENT must be a JSON object'); }
  if (!isRecord(base)) throw new Error('native OPENCODE_CONFIG_CONTENT must be a JSON object');
  const providers = isRecord(base['provider']) ? base['provider'] : {};
  const selectedProvider = providers[state.model.provider];
  const provider = isRecord(selectedProvider) ? selectedProvider : {};
  const models = isRecord(provider['models']) ? provider['models'] : {};
  const selectedModel = models[state.model.model];
  const model = isRecord(selectedModel) ? selectedModel : {};
  const agents = isRecord(base['agent']) ? base['agent'] : {};
  const agent = isRecord(agents[OPENCODE_REVIEW_AGENT]) ? agents[OPENCODE_REVIEW_AGENT] : {};
  return JSON.stringify({ ...base,
    provider: { ...providers, [state.model.provider]: { ...provider,
      options: { ...(isRecord(provider['options']) ? provider['options'] : {}),
        baseURL: state.model.endpoint, apiKey: '{env:REDLINE_MODEL_API_KEY}' },
      models: { ...models, [state.model.model]: { ...model } },
    } },
    agent: { ...agents, [OPENCODE_REVIEW_AGENT]: { ...agent, prompt: prompt.system } },
  });
}

/** Text payload from one OpenCode JSON event, when present. */
function openCodeTextPart(line: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isRecord(parsed) || !isRecord(parsed['part']) || parsed['part']['type'] !== 'text') return undefined;
    const text = parsed['part']['text'];
    return typeof text === 'string' && text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extracts the assistant text from OpenCode's newline-delimited JSON event
 * stream. Text parts arrive as `{"part":{"type":"text","text":...}}` events.
 */
export function extractOpenCodeAssistantText(stdout: string): string | undefined {
  const parts = stdout.split('\n').flatMap((line) => {
    const text = openCodeTextPart(line);
    return text === undefined ? [] : [text];
  });
  return parts.length > 0 ? parts.join('') : undefined;
}

/** Only runtime error events are read. Response bodies and reasoning are never copied. */
function openCodeFailure(result: BoundedRunResult, credential?: string, native = false) {
  let message = result.stderr || result.error || '';
  let nativeRetryable = false;
  let reported = false;
  for (const line of result.stdout.split('\n')) {
    let frame: unknown;
    try { frame = JSON.parse(line); } catch { continue; }
    if (!isRecord(frame) || frame['type'] !== 'error' || !isRecord(frame['error'])) continue;
    reported = true;
    const error = frame['error'];
    const data = isRecord(error['data']) ? error['data'] : error;
    const detail = typeof data['message'] === 'string' ? data['message'] : '';
    const status = data['statusCode'];
    message = `${Number.isInteger(status) && Number(status) >= 400 && Number(status) <= 599 ? `HTTP ${status} ` : ''}${detail}`.trim() || message;
    nativeRetryable = data['isRetryable'] === true;
  }
  message = redactModelFailure(message, credential);
  if (message === '' && !reported) return undefined;
  const classification = classifyModelFailure(message, true);
  return { message: native ? NATIVE_DIAGNOSTIC : message || 'OpenCode reported a runtime error', reported,
    ...classification, retryable: classification.scope === 'file' && (classification.retryable || nativeRetryable) };
}

/** Project bounded process results into review status, retry classification, safe diagnostics, and observed tool telemetry. */
function toHarnessRun(result: BoundedRunResult, timeToFirstTextMs: number | null, state: PreparedOpenCode): HarnessRun {
  const failure = state.retryOwnership === 'caller' ? openCodeFailure(result, state.credential, state.native !== undefined) : undefined;
  const diagnostic = state.native === undefined || result.stderr === '' ? result.stderr : NATIVE_DIAGNOSTIC;
  const text = result.code === 0 && failure?.reported !== true ? extractOpenCodeAssistantText(result.stdout) : undefined;
  const telemetry = {
    processStartupMs: result.processStartupMs ?? null,
    timeToFirstTextMs,
    stdoutBytes: result.stdoutBytes ?? Buffer.byteLength(result.stdout, 'utf8'),
    stderrBytes: result.stderrBytes ?? Buffer.byteLength(result.stderr, 'utf8'),
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated ?? false,
    ...(state.native === undefined ? {} : { tools: nativeToolEvidence(result.stdout, 'opencode', result.stdoutTruncated) }),
  };
  if (result.timedOut) {
    return {
      status: 'timed-out',
      harness: 'opencode',
      exitCode: result.code,
      text: '',
      diagnostic,
      durationMs: result.durationMs,
      telemetry,
    };
  }
  if (text === undefined) {
    return {
      status: 'failed',
      harness: 'opencode',
      exitCode: result.code,
      text: '',
      ...(failure === undefined ? {} : { failureScope: failure.scope, retryable: failure.retryable }),
      diagnostic:
        failure?.message || diagnostic ||
        (result.error !== undefined
          ? state.native === undefined ? result.error : NATIVE_DIAGNOSTIC
          : `opencode exited with code ${result.code ?? 'null'} and produced no assistant text`),
      durationMs: result.durationMs,
      telemetry,
    };
  }
  return {
    status: 'succeeded',
    harness: 'opencode',
    exitCode: result.code,
    text,
    diagnostic,
    durationMs: result.durationMs,
    telemetry,
  };
}

/** Construct an OpenCode executor with injected launch dependencies and explicit native or isolated configuration ownership. */
export function createOpenCodeExecutor(options: OpenCodeExecutorOptions = {}): HarnessExecutor {
  const command = options.command ?? 'opencode';
  const spawner = options.spawner ?? nodeProcessSpawner;
  return {
    harness: 'opencode',
    /** Validate supported controls and prepare either native settings or isolated analysis without starting a review model call. */
    async prepare(settings: HarnessSettings): Promise<PreparedOpenCode> {
      if (settings.modelProtocol === 'openrouter-json') throw new Error('openrouter-json is not supported by the OpenCode executor');
      const maxOutputTokens = settings.maxOutputTokens === undefined ? undefined : validateOutputTokens(settings.maxOutputTokens);
      const rootDirectory = join(settings.workDirectory, 'opencode');
      await mkdir(rootDirectory, { recursive: true });
      const analysis = options.native === undefined
        ? await prepareAnalysis(settings.analysis, settings.workDirectory, 'opencode', command) : undefined;
      const modelOptions: Record<string, string> = { baseURL: settings.model.endpoint };
      if (settings.credential !== undefined) modelOptions['apiKey'] = settings.credential.value;
      const modelConfig = {
        provider: settings.model.provider,
        model: settings.model.model,
        options: modelOptions,
      };
      const args = [
        'run',
        ...(options.native === undefined ? ['--pure'] : ['--dir', options.native.directory]),
        '--format',
        'json',
        '--agent',
        OPENCODE_REVIEW_AGENT,
        '--title',
        'redline-review',
        '--model',
        `${settings.model.provider}/${settings.model.model}`,
      ];
      const env: Record<string, string | undefined> = {
        ...(options.native === undefined ? { PATH: process.env.PATH, LANG: process.env.LANG }
          : { ...nativeEnvironment(options.native.environment), REDLINE_MODEL_API_KEY: settings.credential?.value ?? 'redline-unauthenticated' }),
        ...(maxOutputTokens === undefined ? {} : { OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: String(maxOutputTokens) }),
      };
      return Object.freeze({
        harness: 'opencode',
        model: settings.model,
        executionMode: options.native === undefined ? 'isolated' : 'native',
        ...(options.native === undefined ? {} : { native: options.native }),
        ...(analysis === undefined ? {} : { analysis }),
        description: options.native !== undefined ? 'opencode with native global and checkout-local configuration; configured tools and plugins remain enabled' : `opencode with isolated per-invocation config and XDG/HOME directories under ${rootDirectory}; max-output-tokens=${maxOutputTokens ?? 'provider-default'}`,
        command,
        args,
        cwd: options.native?.directory ?? settings.workDirectory,
        rootDirectory,
        env,
        timeoutMs: settings.timeoutMs,
        retryOwnership: settings.retryOwnership,
        credential: settings.credential?.value,
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
        modelConfig,
      });
    },
    /** Own invocation configuration and bounded process I/O; suppress native diagnostics that can contain expanded configuration credentials. */
    async execute(
      prepared: PreparedHarness,
      prompt: HarnessPrompt,
      options?: HarnessExecuteOptions,
    ): Promise<HarnessRun> {
      const state = prepared as PreparedOpenCode;
      const invocationRoot = await mkdtemp(join(state.rootDirectory, 'invocation-'));
      const configDirectory = join(invocationRoot, 'config');
      const dataDirectory = join(invocationRoot, 'data');
      const stateDirectory = join(invocationRoot, 'state');
      const homeDirectory = join(invocationRoot, 'home');
      const env: NodeJS.ProcessEnv = { ...state.env };
      if (state.native === undefined) {
        await Promise.all([configDirectory, dataDirectory, stateDirectory, homeDirectory].map(
          (directory) => mkdir(directory, { recursive: true }),
        ));
        const configFile = join(configDirectory, 'opencode.json');
        await writeFile(configFile, buildConfig(state.modelConfig, prompt.system, state.analysis), { mode: 0o600 });
        Object.assign(env, { HOME: homeDirectory, USERPROFILE: homeDirectory,
          XDG_CONFIG_HOME: configDirectory, XDG_DATA_HOME: dataDirectory,
          XDG_STATE_HOME: stateDirectory, OPENCODE_CONFIG: configFile });
      } else env.OPENCODE_CONFIG_CONTENT = nativeConfig(state, prompt);
      const invocationStartedAt = Date.now();
      let timeToFirstTextMs: number | null = null;
      let nativeDiagnosticReported = false;
      const result = await runBoundedProcess(spawner, {
        command: state.command,
        args: state.args,
        cwd: state.cwd,
        env,
        stdin: prompt.user,
        timeoutMs: options?.timeoutMs ?? state.timeoutMs,
        stdoutLimitBytes: outputCaptureBytes(state.maxOutputTokens),
        // `opencode run --format json` emits model text at the end. Capture
        // first-text latency even when live log streaming is not requested.
        onOutputLine: (stream: 'stdout' | 'stderr', line: string) => {
          if (stream === 'stdout' && timeToFirstTextMs === null && openCodeTextPart(line) !== undefined) {
            timeToFirstTextMs = Math.max(0, Date.now() - invocationStartedAt);
          }
          if (stream === 'stderr' && (state.native === undefined || !nativeDiagnosticReported)) {
            options?.onOutputLine?.({ stream, kind: 'line', line: state.native === undefined ? line : NATIVE_DIAGNOSTIC });
            nativeDiagnosticReported = true;
          }
        },
      });
      return toHarnessRun(result, timeToFirstTextMs, state);
    },
  };
}
