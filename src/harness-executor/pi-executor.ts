/**
 * Pi harness executor.
 *
 * Runs Pi non-interactively: one `pi --print` child process per prompt with
 * all tools disabled and no session persistence. Model access is configured
 * through a dedicated generated agent directory (`PI_CODING_AGENT_DIR`), so
 * the host user's own Pi configuration, extensions, and credentials are
 * never loaded or modified. The provider credential travels through the
 * `REDLINE_MODEL_API_KEY` environment variable, which `models.json`
 * references by interpolation; the credential value never appears in any
 * generated file.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isRecord,
  nodeProcessSpawner,
  parseJsonLines,
  runBoundedProcess,
  type BoundedRunResult,
  type ProcessSpawner,
} from './process-runner.js';
import type {
  HarnessExecuteOptions,
  HarnessExecutor,
  HarnessPrompt,
  HarnessRun,
  HarnessSettings,
  PreparedHarness,
} from './types.js';

/** Event boundaries forwarded as heartbeat lines; event content never is. */
const PI_HEARTBEAT_EVENTS = new Set(['message_end', 'turn_end', 'agent_end']);

/** Environment variable `models.json` interpolates for the provider credential. */
export const PI_CREDENTIAL_ENV_NAME = 'REDLINE_MODEL_API_KEY' as const;

export interface PiExecutorOptions {
  /** Executable override; defaults to the `pi` found on PATH. */
  readonly command?: string | undefined;
  readonly spawner?: ProcessSpawner | undefined;
}

export interface PreparedPi extends PreparedHarness {
  readonly harness: 'pi';
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
}

function buildAgentConfig(settings: HarnessSettings): string {
  const provider = settings.model.provider;
  const apiKey = settings.credential === undefined ? 'redline-unauthenticated' : `$${PI_CREDENTIAL_ENV_NAME}`;
  // The environment contract only permits OpenAI-compatible endpoints,
  // which map to Pi's openai-completions API.
  const config = {
    providers: {
      [provider]: {
        baseUrl: settings.model.endpoint,
        api: 'openai-completions',
        apiKey,
        models: [{ id: settings.model.model }],
      },
    },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * Extracts the assistant text from Pi's newline-delimited JSON event stream.
 * The final `turn_end` event carries the assistant message of the turn.
 */
export function extractPiAssistantText(stdout: string): string | undefined {
  let lastTurnEnd: Record<string, unknown> | undefined;
  for (const event of parseJsonLines(stdout)) {
    if (event['type'] === 'turn_end') lastTurnEnd = event;
  }
  if (lastTurnEnd === undefined) return undefined;
  const message = lastTurnEnd['message'];
  if (!isRecord(message) || !Array.isArray(message['content'])) return undefined;
  const parts: string[] = [];
  for (const part of message['content']) {
    if (isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string') {
      parts.push(part['text']);
    }
  }
  const text = parts.join('');
  return text.length > 0 ? text : undefined;
}

function toHarnessRun(result: BoundedRunResult): HarnessRun {
  const text = result.code === 0 ? extractPiAssistantText(result.stdout) : undefined;
  if (result.timedOut) {
    return {
      status: 'timed-out',
      harness: 'pi',
      exitCode: result.code,
      text: '',
      diagnostic: result.stderr,
      durationMs: result.durationMs,
    };
  }
  if (text === undefined) {
    return {
      status: 'failed',
      harness: 'pi',
      exitCode: result.code,
      text: '',
      diagnostic:
        result.stderr ||
        (result.error !== undefined
          ? result.error
          : `pi exited with code ${result.code ?? 'null'} and produced no assistant text`),
      durationMs: result.durationMs,
    };
  }
  return {
    status: 'succeeded',
    harness: 'pi',
    exitCode: result.code,
    text,
    diagnostic: result.stderr,
    durationMs: result.durationMs,
  };
}

export function createPiExecutor(options: PiExecutorOptions = {}): HarnessExecutor {
  const command = options.command ?? 'pi';
  const spawner = options.spawner ?? nodeProcessSpawner;
  return {
    harness: 'pi',
    async prepare(settings: HarnessSettings): Promise<PreparedPi> {
      const directory = join(settings.workDirectory, 'pi-agent');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'models.json'), buildAgentConfig(settings), { mode: 0o600 });
      const args = [
        '--print',
        '--mode',
        'json',
        '--no-session',
        '--no-tools',
        '--provider',
        settings.model.provider,
        '--model',
        settings.model.model,
      ];
      const env: Record<string, string | undefined> = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG,
        PI_CODING_AGENT_DIR: directory,
      };
      if (settings.credential !== undefined) {
        env[PI_CREDENTIAL_ENV_NAME] = settings.credential.value;
      }
      return Object.freeze({
        harness: 'pi',
        model: settings.model,
        description: `pi with generated agent directory ${directory} (credential via ${PI_CREDENTIAL_ENV_NAME} interpolation)`,
        command,
        args,
        cwd: settings.workDirectory,
        env,
        timeoutMs: settings.timeoutMs,
      });
    },
    async execute(prepared: PreparedHarness, prompt: HarnessPrompt, options?: HarnessExecuteOptions): Promise<HarnessRun> {
      const state = prepared as PreparedPi;
      const args = [...state.args, '--system-prompt', prompt.system, '--', prompt.user];
      const result = await runBoundedProcess(spawner, {
        command: state.command,
        args,
        cwd: state.cwd,
        env: state.env,
        timeoutMs: state.timeoutMs,
        // Live heartbeat: pi streams newline-delimited JSON events. Only
        // event boundaries are forwarded — never event content, which can
        // quote pull request data — so the run log shows progress without
        // dumping the model stream.
        ...(options?.onOutputLine !== undefined
          ? {
              onOutputLine: (stream: 'stdout' | 'stderr', line: string) => {
                if (stream === 'stderr') {
                  options.onOutputLine?.({ stream, line });
                  return;
                }
                const type = /^\s*\{"type":"([a-z_]+)"/u.exec(line)?.[1];
                if (type !== undefined && PI_HEARTBEAT_EVENTS.has(type)) {
                  options.onOutputLine?.({ stream, line: `pi event: ${type}` });
                }
              },
            }
          : {}),
      });
      return toHarnessRun(result);
    },
  };
}
