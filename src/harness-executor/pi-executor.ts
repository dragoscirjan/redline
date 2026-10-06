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

/** Event kinds whose `delta` is the model's readable streaming text. */
const PI_TEXT_DELTA_EVENTS = new Set(['thinking_delta', 'text_delta']);
/** Event kinds that close a streamed segment; the log gets a newline. */
const PI_TEXT_END_EVENTS = new Set(['thinking_end', 'text_end']);

/** Per-run cap on forwarded readable text, keeping the run log bounded. */
const MAX_STREAMED_TEXT_BYTES = 32 * 1024;

/**
 * Decodes one pi NDJSON event line into the readable output the run log
 * should show: `undefined` for event kinds without reader-facing text.
 */
function streamEventLine(line: string): { kind: 'text' | 'newline'; text: string } | undefined {
  try {
    const event = JSON.parse(line) as { type?: unknown; assistantMessageEvent?: { type?: unknown; delta?: unknown } };
    if (event.type !== 'message_update') return undefined;
    const delta = event.assistantMessageEvent?.delta;
    if (event.assistantMessageEvent?.type === undefined) return undefined;
    if (PI_TEXT_DELTA_EVENTS.has(event.assistantMessageEvent.type as string)) {
      return typeof delta === 'string' && delta.length > 0 ? { kind: 'text', text: delta } : undefined;
    }
    if (PI_TEXT_END_EVENTS.has(event.assistantMessageEvent.type as string)) return { kind: 'newline', text: '\n' };
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Neutralizes GitHub Actions workflow-command syntax in raw text: the
 * runner interprets lines starting with `##[` or `::` as commands. The
 * model stream is untrusted, so those sequences never survive raw.
 */
function sanitizeWorkflowCommands(chunk: string, atLineStart: boolean): string {
  let sanitized = chunk;
  if (atLineStart && (sanitized.startsWith('##[') || sanitized.startsWith('::'))) {
    sanitized = ` ${sanitized}`;
  }
  return sanitized.replaceAll('##[', '# #[').replaceAll('\n##[', '\n# #[').replaceAll('\n::', '\n: :');
}

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
      // Readable live output: the NDJSON event stream is decoded, and the
      // model's text deltas are forwarded per the stream mode — raw
      // fragments ('text') or one dot per chunk ('dots'). Text is
      // redacted against the credential and capped; boundary events stay
      // compact lines in text mode and are suppressed in dots mode.
      const streamMode = options?.streamMode ?? 'text';
      const credential = state.env[PI_CREDENTIAL_ENV_NAME];
      let streamedBytes = 0;
      let capReported = false;
      const forwardText = (text: string): void => {
        const rendered = streamMode === 'dots' ? (text === '\n' ? '\n' : '.') : text;
        const redacted = credential !== undefined ? rendered.split(credential).join('[redacted]') : rendered;
        const remaining = MAX_STREAMED_TEXT_BYTES - streamedBytes;
        if (remaining <= 0) {
          if (!capReported) {
            capReported = true;
            options?.onOutputLine?.({
              stream: 'stdout',
              kind: 'line',
              line: 'pi text stream truncated in the log (full output is in the artifacts)',
            });
          }
          return;
        }
        const bounded = redacted.slice(0, remaining);
        const atRunStart = streamedBytes === 0;
        streamedBytes += Buffer.byteLength(bounded, 'utf8');
        // The sanitizer also guards after-newline positions inside the
        // fragment; the run-start flag covers the very first fragment.
        options?.onOutputLine?.({ stream: 'stdout', kind: 'text', line: sanitizeWorkflowCommands(bounded, atRunStart) });
        if (bounded.length < redacted.length && !capReported) {
          capReported = true;
          options?.onOutputLine?.({
            stream: 'stdout',
            kind: 'line',
            line: 'pi text stream truncated in the log (full output is in the artifacts)',
          });
        }
      };
      const result = await runBoundedProcess(spawner, {
        command: state.command,
        args,
        cwd: state.cwd,
        env: state.env,
        timeoutMs: state.timeoutMs,
        ...(options?.onOutputLine !== undefined
          ? {
              onOutputLine: (stream: 'stdout' | 'stderr', line: string) => {
                if (stream === 'stderr') {
                  options.onOutputLine?.({ stream, kind: 'line', line });
                  return;
                }
                const event = streamEventLine(line);
                if (event !== undefined) {
                  forwardText(event.text);
                  return;
                }
                const type = /^\s*\{"type":"([a-z_]+)"/u.exec(line)?.[1];
                if (streamMode === 'text' && type !== undefined && PI_HEARTBEAT_EVENTS.has(type)) {
                  options.onOutputLine?.({ stream, kind: 'line', line: `pi event: ${type}` });
                }
              },
            }
          : {}),
      });
      return toHarnessRun(result);
    },
  };
}
