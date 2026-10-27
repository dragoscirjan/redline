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

import { MAX_OUTPUT_TOKENS, outputCaptureBytes } from './output-budget.ts';
import { piFailureDiagnostic, readPiFailure } from './pi-failure.ts';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
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
  HarnessPrompt,
  HarnessRun,
  HarnessSettings,
  HarnessUsageTelemetry,
  PreparedHarness,
} from './types.ts';

/** Event boundaries forwarded as heartbeat lines; event content never is. */
const PI_HEARTBEAT_EVENTS = new Set(['message_end', 'turn_end', 'agent_end', 'agent_settled']);

/** Event kinds whose `delta` is the model's readable streaming text. */
const PI_TEXT_DELTA_EVENTS = new Set(['thinking_delta', 'text_delta']);
/** Event kinds that close a streamed segment; the log gets a newline. */
const PI_TEXT_END_EVENTS = new Set(['thinking_end', 'text_end']);

/** Per-run cap on forwarded readable text, keeping the run log bounded. */
const MAX_STREAMED_TEXT_BYTES = 32 * 1024;
/** Bounded suffixes recorded in no-assistant-text diagnostics. */
const MAX_DIAGNOSTIC_TYPES = 3;
const PI_TRANSIENT_RETRY_DELAY_MS = 250;

export const PI_THINKING_LEVELS = ['off', 'minimal', 'low'] as const;
export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];
export type PiStructuredOutput = 'none' | 'json-object';
export const DEFAULT_PI_THINKING_LEVEL: PiThinkingLevel | undefined = undefined;
export const DEFAULT_PI_MAX_OUTPUT_TOKENS = 16_384;
export const MIN_PI_MAX_OUTPUT_TOKENS = 1_024;
export const MAX_PI_MAX_OUTPUT_TOKENS = MAX_OUTPUT_TOKENS;

type PiDiagnosticEventType =
  | 'session'
  | 'agent_start'
  | 'turn_start'
  | 'message_start'
  | 'message_update'
  | 'message_end'
  | 'turn_end'
  | 'agent_end'
  | 'agent_settled'
  | 'tool_start'
  | 'tool_update'
  | 'tool_end'
  | 'other';

type PiDiagnosticContentType = 'text' | 'thinking' | 'toolCall' | 'image' | 'other' | 'invalid';
type PiDiagnosticStopReason = 'pending' | 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' | 'deferred' | 'other';

export type PiNoAssistantTextClassification =
  | 'capture-truncated'
  | 'malformed-events'
  | 'missing-turn-end'
  | 'missing-text-parts'
  | 'empty-text'
  | 'model-output-budget-exhausted';

export interface PiAssistantOutputInspection {
  readonly text: string | undefined;
  readonly classification: PiNoAssistantTextClassification | undefined;
  readonly malformedEvents: number;
  readonly finalEventTypes: readonly PiDiagnosticEventType[];
  readonly contentPartTypes: readonly PiDiagnosticContentType[];
  readonly stopReason: PiDiagnosticStopReason | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
}

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
  /** Trusted policy override used by controlled benchmarks. */
  readonly thinkingLevel?: PiThinkingLevel | undefined;
  /** Trusted policy override used by controlled benchmarks. */
  readonly maxOutputTokens?: number | undefined;
  /** Trusted deterministic benchmark override; production leaves provider sampling unchanged. */
  readonly temperature?: 0 | undefined;
  /** Benchmark-only native response-format probe; production uses `none`. */
  readonly structuredOutput?: PiStructuredOutput | undefined;
  /** Production permits one Redline-controlled retry for classified transient provider failures. */
  readonly transientRetries?: 0 | 1 | undefined;
}

export interface PreparedPi extends PreparedHarness {
  readonly harness: 'pi';
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly rootDirectory: string;
  readonly agentConfig: string;
  readonly modelProtocol: 'compatible' | 'openrouter-json';
  readonly settingsConfig: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
  readonly transientRetries: 0 | 1;
  readonly maxOutputTokens: number;
}

interface PiExecutionPolicy {
  readonly thinkingLevel: PiThinkingLevel | undefined;
  readonly maxOutputTokens: number;
  readonly temperature: 0 | undefined;
  readonly structuredOutput: PiStructuredOutput;
  readonly transientRetries: 0 | 1;
}

function validatePolicy(options: PiExecutorOptions): PiExecutionPolicy {
  const thinkingLevel = options.thinkingLevel ?? DEFAULT_PI_THINKING_LEVEL;
  if (thinkingLevel === 'off') throw new Error('Never disable model reasoning; preserve provider/model defaults');
  if (thinkingLevel !== undefined && !(PI_THINKING_LEVELS as readonly string[]).includes(thinkingLevel)) {
    throw new Error('Pi thinking level must be provider-default, minimal, or low');
  }
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_PI_MAX_OUTPUT_TOKENS;
  if (!Number.isSafeInteger(maxOutputTokens)
    || maxOutputTokens < MIN_PI_MAX_OUTPUT_TOKENS
    || maxOutputTokens > MAX_PI_MAX_OUTPUT_TOKENS) {
    throw new Error(`Pi max output tokens must be an integer from ${MIN_PI_MAX_OUTPUT_TOKENS} through ${MAX_PI_MAX_OUTPUT_TOKENS}`);
  }
  const structuredOutput = options.structuredOutput ?? 'none';
  if (structuredOutput !== 'none' && structuredOutput !== 'json-object') {
    throw new Error('Pi structured output must be none or json-object');
  }
  const transientRetries = options.transientRetries ?? 1;
  if (transientRetries !== 0 && transientRetries !== 1) {
    throw new Error('Pi transient retries must be zero or one');
  }
  if (options.temperature !== undefined && options.temperature !== 0) {
    throw new Error('Pi benchmark temperature must be zero when specified');
  }
  return Object.freeze({
    thinkingLevel,
    maxOutputTokens,
    temperature: options.temperature,
    structuredOutput,
    transientRetries,
  });
}

function buildAgentConfig(settings: HarnessSettings, policy: PiExecutionPolicy): string {
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
        models: [{
          id: settings.model.model,
          ...(policy.thinkingLevel === undefined ? {} : { reasoning: true }),
          maxTokens: policy.maxOutputTokens,
          ...(policy.temperature === undefined && policy.structuredOutput === 'none' && settings.modelProtocol !== 'openrouter-json' ? {} : {
            samplingParams: {
              ...(policy.temperature === undefined ? {} : { temperature: policy.temperature }),
              ...(settings.modelProtocol === 'openrouter-json' ? {
                provider: { require_parameters: true },
                response_format: { type: 'json_object' },
              } : {}),
              ...(policy.structuredOutput === 'json-object'
                ? { response_format: { type: 'json_object' } }
                : {}),
            },
          }),
        }],
      },
    },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

function invocationAgentConfig(state: PreparedPi, prompt: HarnessPrompt): string {
  if (state.modelProtocol !== 'openrouter-json' || prompt.responseSchema === undefined) return state.agentConfig;
  const config = JSON.parse(state.agentConfig) as { providers: Record<string, { models: { samplingParams: Record<string, unknown> }[] }> };
  config.providers[state.model.provider]!.models[0]!.samplingParams['response_format'] = {
    type: 'json_schema', json_schema: { name: 'redline_file_review', strict: true, schema: prompt.responseSchema },
  };
  return JSON.stringify(config);
}

function buildSettingsConfig(policy: PiExecutionPolicy): string {
  return `${JSON.stringify({
    defaultThinkingLevel: policy.thinkingLevel,
    retry: {
      enabled: false,
      maxRetries: 0,
      provider: { maxRetries: 0 },
    },
  }, null, 2)}\n`;
}

function diagnosticEventType(value: unknown): PiDiagnosticEventType {
  switch (value) {
    case 'session':
    case 'agent_start':
    case 'turn_start':
    case 'message_start':
    case 'message_update':
    case 'message_end':
    case 'turn_end':
    case 'agent_end':
    case 'agent_settled':
      return value;
    case 'tool_execution_start':
      return 'tool_start';
    case 'tool_execution_update':
      return 'tool_update';
    case 'tool_execution_end':
      return 'tool_end';
    default:
      return 'other';
  }
}

function diagnosticContentType(value: unknown): PiDiagnosticContentType {
  switch (value) {
    case 'text':
    case 'thinking':
    case 'toolCall':
    case 'image':
      return value;
    default:
      return typeof value === 'string' ? 'other' : 'invalid';
  }
}

function diagnosticStopReason(value: unknown): PiDiagnosticStopReason | null {
  switch (value) {
    case 'pending':
    case 'stop':
    case 'length':
    case 'toolUse':
    case 'error':
    case 'aborted':
    case 'deferred':
      return value;
    default:
      return typeof value === 'string' ? 'other' : null;
  }
}

function boundedNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER);
}

function boundedCost(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.min(value, Number.MAX_SAFE_INTEGER);
}

/**
 * Inspects Pi's retained NDJSON without retaining event payloads in the
 * result. Only bounded type labels and numeric counters leave this function.
 */
export function inspectPiAssistantOutput(stdout: string, stdoutTruncated = false): PiAssistantOutputInspection {
  let lastTurnEnd: Record<string, unknown> | undefined;
  let lastAssistantMessage: Record<string, unknown> | undefined;
  let settledAfterLastTurnEnd = false;
  let malformedEvents = 0;
  const finalEventTypes: PiDiagnosticEventType[] = [];

  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      malformedEvents += 1;
      continue;
    }
    if (!isRecord(event) || typeof event['type'] !== 'string') {
      malformedEvents += 1;
      continue;
    }
    finalEventTypes.push(diagnosticEventType(event['type']));
    if (finalEventTypes.length > MAX_DIAGNOSTIC_TYPES) finalEventTypes.shift();
    if (event['type'] === 'turn_start') settledAfterLastTurnEnd = false;
    if (event['type'] === 'turn_end') {
      lastTurnEnd = event;
      settledAfterLastTurnEnd = false;
    }
    if (event['type'] === 'agent_settled' && lastTurnEnd !== undefined) settledAfterLastTurnEnd = true;
    if (event['type'] === 'turn_end' || event['type'] === 'message_end') {
      const message = event['message'];
      if (isRecord(message) && message['role'] === 'assistant') lastAssistantMessage = message;
    }
  }

  const turnMessage = lastTurnEnd?.['message'];
  const finalMessage = isRecord(turnMessage) ? turnMessage : lastAssistantMessage;
  const diagnosticContent = finalMessage?.['content'];
  const contentPartTypes = Array.isArray(diagnosticContent)
    ? diagnosticContent
        .slice(-MAX_DIAGNOSTIC_TYPES)
        .map((part) => diagnosticContentType(isRecord(part) ? part['type'] : undefined))
    : [];
  const stopReason = diagnosticStopReason(finalMessage?.['stopReason']);
  const usage = finalMessage?.['usage'];
  const inputTokens = boundedNumber(isRecord(usage) ? usage['input'] : undefined);
  const outputTokens = boundedNumber(isRecord(usage) ? usage['output'] : undefined);
  const cacheReadTokens = boundedNumber(isRecord(usage) ? usage['cacheRead'] : undefined);
  const cacheWriteTokens = boundedNumber(isRecord(usage) ? usage['cacheWrite'] : undefined);
  const explicitTotalTokens = boundedNumber(isRecord(usage) ? usage['totalTokens'] : undefined);
  const totalTokens = explicitTotalTokens
    ?? (inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens);
  const cost = isRecord(usage) && isRecord(usage['cost']) ? usage['cost'] : undefined;
  const costUsd = boundedCost(isRecord(cost) ? cost['total'] : undefined);
  const turnContent = isRecord(turnMessage) ? turnMessage['content'] : undefined;
  const textParts = Array.isArray(turnContent)
    ? turnContent.filter((part) => isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string')
    : [];
  const text = textParts.map((part) => (part as Record<string, unknown>)['text'] as string).join('');

  if (text.length > 0 && stopReason !== 'error' && (!stdoutTruncated || settledAfterLastTurnEnd)) {
    return {
      text,
      classification: undefined,
      malformedEvents,
      finalEventTypes,
      contentPartTypes,
      stopReason,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens,
      costUsd,
    };
  }

  let classification: PiNoAssistantTextClassification;
  if (stdoutTruncated) classification = 'capture-truncated';
  else if (stopReason === 'length') classification = 'model-output-budget-exhausted';
  else if (malformedEvents > 0) classification = 'malformed-events';
  else if (lastTurnEnd === undefined) classification = 'missing-turn-end';
  else if (!Array.isArray(turnContent) || textParts.length === 0) classification = 'missing-text-parts';
  else classification = 'empty-text';

  return {
    text: undefined,
    classification,
    malformedEvents,
    finalEventTypes,
    contentPartTypes,
    stopReason,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    costUsd,
  };
}

/**
 * Extracts the assistant text from Pi's newline-delimited JSON event stream.
 * The final `turn_end` event carries the assistant message of the turn.
 */
export function extractPiAssistantText(stdout: string): string | undefined {
  return inspectPiAssistantOutput(stdout).text;
}

function diagnosticCause(classification: PiNoAssistantTextClassification): string {
  if (classification === 'capture-truncated') return 'redline-capture';
  if (classification === 'model-output-budget-exhausted') return 'model-output-budget';
  if (classification === 'empty-text' || classification === 'missing-text-parts') return 'provider-output';
  return 'pi-event-stream';
}

function safeMetric(value: number | null | undefined): number | null {
  return boundedNumber(value);
}

/** Serializes a schema-tagged, metadata-only diagnostic below the 500-character artifact limit. */
function noAssistantTextDiagnostic(
  result: BoundedRunResult,
  inspection: PiAssistantOutputInspection,
  timeToFirstTextMs: number | null,
): string {
  const classification = inspection.classification ?? 'missing-text-parts';
  const retainedStdoutBytes = Buffer.byteLength(result.stdout, 'utf8');
  const retainedStderrBytes = Buffer.byteLength(result.stderr, 'utf8');
  const diagnostic = {
    schema: 'pi-no-text/v1',
    class: classification,
    cause: diagnosticCause(classification),
    exit: result.code,
    durationMs: safeMetric(result.durationMs),
    startupMs: safeMetric(result.processStartupMs),
    firstTextMs: safeMetric(timeToFirstTextMs),
    // Stream tuples are [total bytes, retained bytes, truncated].
    stdout: [safeMetric(result.stdoutBytes) ?? retainedStdoutBytes, retainedStdoutBytes, result.stdoutTruncated],
    stderr: [safeMetric(result.stderrBytes) ?? retainedStderrBytes, retainedStderrBytes, result.stderrTruncated ?? false],
    malformed: inspection.malformedEvents,
    events: inspection.finalEventTypes,
    parts: inspection.contentPartTypes,
    stop: inspection.stopReason,
    outputTokens: inspection.outputTokens,
  };
  const serialized = JSON.stringify(diagnostic);
  if (serialized.length <= 500) return serialized;
  return JSON.stringify({ ...diagnostic, events: [], parts: [] });
}

function toHarnessRun(
  result: BoundedRunResult,
  timeToFirstTextMs: number | null,
  retryCount = 0,
  credential?: string,
): HarnessRun {
  const inspection = result.code === 0 ? inspectPiAssistantOutput(result.stdout, result.stdoutTruncated) : undefined;
  const text = inspection?.text;
  const telemetry = {
    processStartupMs: result.processStartupMs ?? null,
    timeToFirstTextMs,
    stdoutBytes: result.stdoutBytes ?? Buffer.byteLength(result.stdout, 'utf8'),
    stderrBytes: result.stderrBytes ?? Buffer.byteLength(result.stderr, 'utf8'),
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated ?? false,
    ...(inspection === undefined ? {} : {
      usage: {
        inputTokens: inspection.inputTokens,
        outputTokens: inspection.outputTokens,
        cacheReadTokens: inspection.cacheReadTokens,
        cacheWriteTokens: inspection.cacheWriteTokens,
        totalTokens: inspection.totalTokens,
        costUsd: inspection.costUsd,
      },
    }),
    retryCount,
  };
  if (result.timedOut) {
    return {
      status: 'timed-out',
      harness: 'pi',
      exitCode: result.code,
      text: '',
      diagnostic: result.stderr,
      durationMs: result.durationMs,
      telemetry,
    };
  }
  if (text === undefined) {
    const failure = result.stdoutTruncated ? undefined : readPiFailure(result.stdout,
      result.code === 0 ? undefined : result.stderr || result.error, credential);
    const diagnostic = failure !== undefined ? piFailureDiagnostic(failure) : result.code === 0 && inspection !== undefined
      ? noAssistantTextDiagnostic(result, inspection, timeToFirstTextMs)
      : result.stderr || result.error || `pi exited with code ${result.code ?? 'null'} and produced no assistant text`;
    return {
      status: 'failed',
      harness: 'pi',
      exitCode: result.code,
      text: '',
      diagnostic,
      ...(failure === undefined ? {} : { failureScope: failure.scope }),
      durationMs: result.durationMs,
      telemetry,
    };
  }
  return {
    status: 'succeeded',
    harness: 'pi',
    exitCode: result.code,
    text,
    diagnostic: result.stderr,
    durationMs: result.durationMs,
    telemetry,
  };
}

function mergeUsage(
  accumulated: HarnessUsageTelemetry | undefined,
  next: HarnessUsageTelemetry | undefined,
): HarnessUsageTelemetry | undefined {
  if (accumulated === undefined) return next;
  if (next === undefined) return accumulated;
  const sum = (left: number | null, right: number | null): number | null =>
    left === null || right === null ? null : left + right;
  return {
    inputTokens: sum(accumulated.inputTokens, next.inputTokens),
    outputTokens: sum(accumulated.outputTokens, next.outputTokens),
    cacheReadTokens: sum(accumulated.cacheReadTokens, next.cacheReadTokens),
    cacheWriteTokens: sum(accumulated.cacheWriteTokens, next.cacheWriteTokens),
    totalTokens: sum(accumulated.totalTokens, next.totalTokens),
    costUsd: sum(accumulated.costUsd, next.costUsd),
  };
}

function isTransientProviderFailure(result: BoundedRunResult, credential?: string): boolean {
  if (result.timedOut || result.stdoutTruncated) return false;
  const failure = readPiFailure(result.stdout, result.code === 0 ? undefined : result.stderr || result.error, credential);
  if (failure !== undefined) return failure.retryable;
  if (result.code !== 0) return false;
  const inspection = inspectPiAssistantOutput(result.stdout);
  return inspection.stopReason === 'stop' && inspection.outputTokens === 0
    && inspection.contentPartTypes.every((part) => part === 'text')
    && (inspection.classification === 'missing-text-parts' || inspection.classification === 'empty-text');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createPiExecutor(options: PiExecutorOptions = {}): HarnessExecutor {
  const command = options.command ?? 'pi';
  const spawner = options.spawner ?? nodeProcessSpawner;
  const policy = validatePolicy(options);
  return {
    harness: 'pi',
    async prepare(settings: HarnessSettings): Promise<PreparedPi> {
      if (settings.modelProtocol === 'openrouter-json' && settings.model.provider !== 'openrouter') {
        throw new Error('openrouter-json requires the openrouter provider');
      }
      const effectivePolicy = settings.maxOutputTokens === undefined ? policy : validatePolicy({ ...options, maxOutputTokens: settings.maxOutputTokens });
      const rootDirectory = join(settings.workDirectory, 'pi-agent');
      await mkdir(rootDirectory, { recursive: true });
      const args = [
        '--print',
        '--mode',
        'json',
        '--no-session',
        '--no-tools',
        ...(effectivePolicy.thinkingLevel === undefined ? [] : ['--thinking', effectivePolicy.thinkingLevel]),
        '--provider',
        settings.model.provider,
        '--model',
        settings.model.model,
      ];
      const env: Record<string, string | undefined> = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG,
        PI_SKIP_VERSION_CHECK: '1',
      };
      if (settings.credential !== undefined) {
        env[PI_CREDENTIAL_ENV_NAME] = settings.credential.value;
      }
      return Object.freeze({
        harness: 'pi',
        model: settings.model,
        description: `pi with isolated per-invocation agent directories under ${rootDirectory}; thinking=${effectivePolicy.thinkingLevel ?? 'provider-default'}, max-output-tokens=${effectivePolicy.maxOutputTokens}, temperature=${effectivePolicy.temperature ?? 'provider-default'}, structured-output=${effectivePolicy.structuredOutput}, model-protocol=${settings.modelProtocol ?? 'compatible'}, transient-retries=${effectivePolicy.transientRetries} (credential via ${PI_CREDENTIAL_ENV_NAME} interpolation)`,
        command,
        args,
        cwd: settings.workDirectory,
        rootDirectory,
        agentConfig: buildAgentConfig(settings, effectivePolicy),
        modelProtocol: settings.modelProtocol ?? 'compatible',
        settingsConfig: buildSettingsConfig(effectivePolicy),
        env,
        timeoutMs: settings.timeoutMs,
        transientRetries: effectivePolicy.transientRetries,
        maxOutputTokens: effectivePolicy.maxOutputTokens,
      });
    },
    async execute(prepared: PreparedHarness, prompt: HarnessPrompt, options?: HarnessExecuteOptions): Promise<HarnessRun> {
      const state = prepared as PreparedPi;
      const totalTimeoutMs = options?.timeoutMs ?? state.timeoutMs;
      if (!Number.isSafeInteger(totalTimeoutMs) || totalTimeoutMs <= 0) {
        throw new Error('process timeout is invalid');
      }
      const invocationStartedAt = performance.now();
      const streamMode = options?.streamMode ?? 'text';
      const credential = state.env[PI_CREDENTIAL_ENV_NAME];
      let streamedBytes = 0;
      let capReported = false;
      let retryCount = 0;
      let accumulatedUsage: HarnessUsageTelemetry | undefined;

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

      for (let attempt = 0; ; attempt += 1) {
        const remainingTimeoutMs = Math.max(
          1,
          Math.floor(totalTimeoutMs - (performance.now() - invocationStartedAt)),
        );
        const invocationDirectory = await mkdtemp(join(state.rootDirectory, 'invocation-'));
        const systemPromptFile = join(invocationDirectory, 'system-prompt.md');
        await Promise.all([
          writeFile(join(invocationDirectory, 'models.json'), invocationAgentConfig(state, prompt), { mode: 0o600 }),
          writeFile(join(invocationDirectory, 'settings.json'), state.settingsConfig, { mode: 0o600 }),
          writeFile(systemPromptFile, prompt.system, { mode: 0o600 }),
        ]);
        const args = [...state.args, '--system-prompt', systemPromptFile];
        const env: NodeJS.ProcessEnv = { ...state.env, PI_CODING_AGENT_DIR: invocationDirectory };
        let timeToFirstTextMs: number | null = null;
        const result = await runBoundedProcess(spawner, {
          command: state.command,
          args,
          cwd: state.cwd,
          env,
          stdin: prompt.user,
          timeoutMs: remainingTimeoutMs,
          stdoutLimitBytes: outputCaptureBytes(state.maxOutputTokens),
          onOutputLine: (stream: 'stdout' | 'stderr', line: string) => {
            if (stream === 'stderr') {
              if (streamMode !== 'off') options?.onOutputLine?.({ stream, kind: 'line', line });
              return;
            }
            const event = streamEventLine(line);
            if (event?.kind === 'text' && timeToFirstTextMs === null) {
              timeToFirstTextMs = Math.max(0, Math.ceil(performance.now() - invocationStartedAt));
            }
            if (streamMode === 'off' || options?.onOutputLine === undefined) return;
            if (event !== undefined) {
              forwardText(event.text);
              return;
            }
            const type = /^\s*\{"type":"([a-z_]+)"/u.exec(line)?.[1];
            if (streamMode === 'text' && type !== undefined && PI_HEARTBEAT_EVENTS.has(type)) {
              options.onOutputLine({ stream, kind: 'line', line: `pi event: ${type}` });
            }
          },
        });
        const run = toHarnessRun(result, timeToFirstTextMs, retryCount, credential);
        accumulatedUsage = mergeUsage(accumulatedUsage, run.telemetry?.usage);
        const elapsedMs = Math.max(0, Math.ceil(performance.now() - invocationStartedAt));
        if (run.status === 'succeeded'
          || attempt >= state.transientRetries
          || !isTransientProviderFailure(result, credential)
          || elapsedMs + PI_TRANSIENT_RETRY_DELAY_MS >= totalTimeoutMs) {
          return {
            ...run,
            durationMs: elapsedMs,
            telemetry: run.telemetry === undefined ? undefined : {
              ...run.telemetry,
              ...(accumulatedUsage === undefined ? {} : { usage: accumulatedUsage }),
            },
          };
        }
        retryCount += 1;
        if (streamMode !== 'off') {
          options?.onOutputLine?.({
            stream: 'stderr',
            kind: 'line',
            line: 'pi transient provider failure; retrying once',
          });
        }
        await delay(PI_TRANSIENT_RETRY_DELAY_MS);
      }
    },
  };
}
