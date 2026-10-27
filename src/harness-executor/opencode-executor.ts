/**
 * OpenCode harness executor.
 *
 * Runs OpenCode non-interactively: one `opencode run` child process per
 * prompt. Model access and the fixed review agent are configured through a
 * generated `OPENCODE_CONFIG` file. The process runs `--pure` (no external
 * plugins) with redirected HOME and XDG directories, so the host user's own
 * OpenCode configuration, plugins, MCP servers, and credentials never load.
 * The generated agent disables every built-in tool, including the skill
 * tool, so the review session is strictly read-only.
 *
 * The selected provider credential is written into the generated config
 * file (mode 0600) inside the caller-managed work directory. OpenCode has
 * no environment-interpolation mechanism comparable to Pi's `models.json`,
 * so that file is the credential boundary; it is removed together with the
 * work directory when the review run ends.
 */

import { outputCaptureBytes, validateOutputTokens } from './output-budget.ts';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isRecord,
  nodeProcessSpawner,
  runBoundedProcess,
  type BoundedRunResult,
  type ProcessSpawner,
} from './process-runner.ts';
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
  /** Executable override; defaults to the `opencode` found on PATH. */
  readonly command?: string | undefined;
  readonly spawner?: ProcessSpawner | undefined;
}

/** Agent name registered by the generated OpenCode configuration. */
export const OPENCODE_REVIEW_AGENT = 'redline-review' as const;

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
  readonly maxOutputTokens?: number | undefined;
  readonly modelConfig: {
    readonly provider: string;
    readonly model: string;
    readonly options: Record<string, string>;
  };
}

function buildConfig(
  modelConfig: PreparedOpenCode['modelConfig'],
  systemPrompt: string,
): string {
  const tools: Record<string, boolean> = {};
  for (const tool of DISABLED_TOOLS) tools[tool] = false;
  const config = {
    $schema: 'https://opencode.ai/config.json',
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
      },
    },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
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

function toHarnessRun(result: BoundedRunResult, timeToFirstTextMs: number | null): HarnessRun {
  const text = result.code === 0 ? extractOpenCodeAssistantText(result.stdout) : undefined;
  const telemetry = {
    processStartupMs: result.processStartupMs ?? null,
    timeToFirstTextMs,
    stdoutBytes: result.stdoutBytes ?? Buffer.byteLength(result.stdout, 'utf8'),
    stderrBytes: result.stderrBytes ?? Buffer.byteLength(result.stderr, 'utf8'),
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated ?? false,
  };
  if (result.timedOut) {
    return {
      status: 'timed-out',
      harness: 'opencode',
      exitCode: result.code,
      text: '',
      diagnostic: result.stderr,
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
      diagnostic:
        result.stderr ||
        (result.error !== undefined
          ? result.error
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
    diagnostic: result.stderr,
    durationMs: result.durationMs,
    telemetry,
  };
}

export function createOpenCodeExecutor(options: OpenCodeExecutorOptions = {}): HarnessExecutor {
  const command = options.command ?? 'opencode';
  const spawner = options.spawner ?? nodeProcessSpawner;
  return {
    harness: 'opencode',
    async prepare(settings: HarnessSettings): Promise<PreparedOpenCode> {
      const maxOutputTokens = settings.maxOutputTokens === undefined ? undefined : validateOutputTokens(settings.maxOutputTokens);
      const rootDirectory = join(settings.workDirectory, 'opencode');
      await mkdir(rootDirectory, { recursive: true });
      const modelOptions: Record<string, string> = { baseURL: settings.model.endpoint };
      if (settings.credential !== undefined) modelOptions['apiKey'] = settings.credential.value;
      const modelConfig = {
        provider: settings.model.provider,
        model: settings.model.model,
        options: modelOptions,
      };
      const args = [
        'run',
        '--pure',
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
        PATH: process.env.PATH,
        LANG: process.env.LANG,
        ...(maxOutputTokens === undefined ? {} : { OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: String(maxOutputTokens) }),
      };
      return Object.freeze({
        harness: 'opencode',
        model: settings.model,
        description: `opencode with isolated per-invocation config and XDG/HOME directories under ${rootDirectory}; max-output-tokens=${maxOutputTokens ?? 'provider-default'}`,
        command,
        args,
        cwd: settings.workDirectory,
        rootDirectory,
        env,
        timeoutMs: settings.timeoutMs,
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
        modelConfig,
      });
    },
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
      await Promise.all([configDirectory, dataDirectory, stateDirectory, homeDirectory].map(
        (directory) => mkdir(directory, { recursive: true }),
      ));
      const configFile = join(configDirectory, 'opencode.json');
      await writeFile(configFile, buildConfig(state.modelConfig, prompt.system), { mode: 0o600 });
      const env = {
        ...state.env,
        HOME: homeDirectory,
        XDG_CONFIG_HOME: configDirectory,
        XDG_DATA_HOME: dataDirectory,
        XDG_STATE_HOME: stateDirectory,
        OPENCODE_CONFIG: configFile,
      };
      const invocationStartedAt = Date.now();
      let timeToFirstTextMs: number | null = null;
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
          if (stream === 'stderr') options?.onOutputLine?.({ stream, kind: 'line', line });
        },
      });
      return toHarnessRun(result, timeToFirstTextMs);
    },
  };
}
