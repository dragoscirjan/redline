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

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isRecord,
  nodeProcessSpawner,
  runBoundedProcess,
  type BoundedRunResult,
  type ProcessSpawner,
} from './process-runner.js';
import type {
  HarnessExecuteOptions,
  HarnessExecutor,
  HarnessOutputLine,
  HarnessPrompt,
  HarnessRun,
  HarnessSettings,
  PreparedHarness,
} from './types.js';

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
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
  readonly configFile: string;
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

/**
 * Extracts the assistant text from OpenCode's newline-delimited JSON event
 * stream. Text parts arrive as `{"part":{"type":"text","text":...}}` events.
 */
export function extractOpenCodeAssistantText(stdout: string): string | undefined {
  const parts: string[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (isRecord(parsed) && isRecord(parsed['part']) && parsed['part']['type'] === 'text') {
      const text = parsed['part']['text'];
      if (typeof text === 'string' && text.length > 0) parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join('') : undefined;
}

function toHarnessRun(result: BoundedRunResult): HarnessRun {
  const text = result.code === 0 ? extractOpenCodeAssistantText(result.stdout) : undefined;
  if (result.timedOut) {
    return {
      status: 'timed-out',
      harness: 'opencode',
      exitCode: result.code,
      text: '',
      diagnostic: result.stderr,
      durationMs: result.durationMs,
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
    };
  }
  return {
    status: 'succeeded',
    harness: 'opencode',
    exitCode: result.code,
    text,
    diagnostic: result.stderr,
    durationMs: result.durationMs,
  };
}

export function createOpenCodeExecutor(options: OpenCodeExecutorOptions = {}): HarnessExecutor {
  const command = options.command ?? 'opencode';
  const spawner = options.spawner ?? nodeProcessSpawner;
  return {
    harness: 'opencode',
    async prepare(settings: HarnessSettings): Promise<PreparedOpenCode> {
      const root = join(settings.workDirectory, 'opencode');
      const configDirectory = join(root, 'config');
      const dataDirectory = join(root, 'data');
      const stateDirectory = join(root, 'state');
      const homeDirectory = join(root, 'home');
      for (const directory of [configDirectory, dataDirectory, stateDirectory, homeDirectory]) {
        await mkdir(directory, { recursive: true });
      }
      const modelOptions: Record<string, string> = { baseURL: settings.model.endpoint };
      if (settings.credential !== undefined) modelOptions['apiKey'] = settings.credential.value;
      const modelConfig = {
        provider: settings.model.provider,
        model: settings.model.model,
        options: modelOptions,
      };
      const configFile = join(configDirectory, 'opencode.json');
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
        HOME: homeDirectory,
        XDG_CONFIG_HOME: configDirectory,
        XDG_DATA_HOME: dataDirectory,
        XDG_STATE_HOME: stateDirectory,
        OPENCODE_CONFIG: configFile,
      };
      return Object.freeze({
        harness: 'opencode',
        model: settings.model,
        description: `opencode with generated config ${configFile} and isolated XDG/HOME directories`,
        command,
        args,
        cwd: settings.workDirectory,
        env,
        timeoutMs: settings.timeoutMs,
        configFile,
        modelConfig,
      });
    },
    async execute(
      prepared: PreparedHarness,
      prompt: HarnessPrompt,
      options?: HarnessExecuteOptions,
    ): Promise<HarnessRun> {
      const state = prepared as PreparedOpenCode;
      // Every `opencode run` is a fresh process, so the agent system prompt
      // (the fixed review policy) is rewritten before each invocation.
      await writeFile(state.configFile, buildConfig(state.modelConfig, prompt.system), { mode: 0o600 });
      const args = [...state.args, '--', prompt.user];
      const result = await runBoundedProcess(spawner, {
        command: state.command,
        args,
        cwd: state.cwd,
        env: state.env,
        timeoutMs: state.timeoutMs,
        // `opencode run --format json` prints once at the end, so there is
        // nothing to heartbeat on stdout; stderr diagnostics forward live.
        ...(options?.onOutputLine !== undefined
          ? {
              onOutputLine: (stream: 'stdout' | 'stderr', line: string) => {
                if (stream === 'stderr') options.onOutputLine?.({ stream, line });
              },
            }
          : {}),
      });
      return toHarnessRun(result);
    },
  };
}
