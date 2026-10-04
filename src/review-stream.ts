import {
  MAX_REVIEW_EVENT_LINE_BYTES,
  MAX_REVIEW_EVENT_STREAM_BYTES,
  MAX_REVIEW_FINDINGS,
  parseReviewEvent,
  type ReviewEvent,
} from './review-report.js';
import { byteLength, isRecord } from './review-bundle.js';

export const OPENCODE_TEXT_DELTA_PREFIX = 'REDLINE_REVIEW_TEXT_DELTA ';
export const OPENCODE_TEXT_END_PREFIX = 'REDLINE_REVIEW_TEXT_END ';
const MAX_HARNESS_EVENT_BYTES = 1024 * 1024;

export type ReviewEventParseResult =
  | { ok: true; event: ReviewEvent }
  | {
      ok: false;
      error: Error;
      lineText: string;
      prose: boolean;
      unsupportedType: boolean;
    };

/** A harness line that is not JSON at all: model narration, not a protocol violation. */
export class ProseLineError extends Error {}

/** A JSON event whose type the protocol does not define: model chatter, dropped. */
export class UnsupportedEventTypeError extends Error {}

export class ReviewEventStreamParser {
  #buffer = '';
  #bytes = 0;
  #findingCount = 0;
  #completed = false;

  get completed(): boolean {
    return this.#completed;
  }

  push(text: string): ReviewEventParseResult[] {
    this.#bytes += byteLength(text);
    if (this.#bytes > MAX_REVIEW_EVENT_STREAM_BYTES) throw new Error('review event stream exceeds its byte limit');
    this.#buffer += text;
    if (byteLength(this.#buffer) > MAX_REVIEW_EVENT_LINE_BYTES && !this.#buffer.includes('\n')) {
      throw new Error('review event line exceeds its byte limit');
    }

    const results: ReviewEventParseResult[] = [];
    while (true) {
      const newline = this.#buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.#buffer.slice(0, newline).replace(/\r$/u, '');
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length === 0) continue;
      results.push(this.#parseLine(line, line));
    }
    return results;
  }

  finishSegment(): ReviewEventParseResult[] {
    if (this.#buffer.length === 0) return [];
    const line = this.#buffer.replace(/\r$/u, '');
    this.#buffer = '';
    if (line.length === 0) return [];
    return [this.#parseLine(line, line)];
  }

  finish(): ReviewEventParseResult[] {
    return this.finishSegment();
  }

  #parseLine(line: string, lineText?: string): ReviewEventParseResult {
    try {
      if (byteLength(line) > MAX_REVIEW_EVENT_LINE_BYTES) throw new Error('review event line exceeds its byte limit');
      if (this.#completed) throw new Error('review event appears after completion');
      let decoded: unknown;
      try {
        decoded = JSON.parse(line) as unknown;
      } catch {
        // Reviewing models narrate in prose between tool calls; a line that
        // is not JSON at all is narration, not a protocol violation.
        throw new ProseLineError('review event line is not valid JSON (treated as narration)');
      }
      if (
        !isRecord(decoded) ||
        (decoded.type !== 'finding' && decoded.type !== 'completion')
      ) {
        // Reviewing models emit informational events (progress notes and
        // similar) alongside the protocol; unknown types are dropped, never
        // fatal — the completion event still gates correctness.
        throw new UnsupportedEventTypeError('review event type is unsupported (dropped as chatter)');
      }
      const event = parseReviewEvent(decoded);
      if (event.type === 'finding') {
        this.#findingCount += 1;
        if (this.#findingCount > MAX_REVIEW_FINDINGS) throw new Error('review event stream exceeds the finding limit');
      } else {
        this.#completed = true;
      }
      return { ok: true, event };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error : new Error(String(error)),
        lineText: lineText ?? line,
        prose: error instanceof ProseLineError,
        unsupportedType: error instanceof UnsupportedEventTypeError,
      };
    }
  }
}

function parseHarnessEvent(line: string, label: string): Record<string, unknown> | undefined {
  if (byteLength(line) > MAX_HARNESS_EVENT_BYTES) throw new Error(`${label} event exceeds its byte limit`);
  let event: unknown;
  try {
    event = JSON.parse(line) as unknown;
  } catch {
    throw new Error(`${label} event is not valid JSON`);
  }
  return isRecord(event) ? event : undefined;
}

export function extractPiTextDelta(line: string): string | undefined {
  const event = parseHarnessEvent(line, 'Pi');
  if (!event || event.type !== 'message_update') return undefined;
  const assistant = event.assistantMessageEvent;
  if (!isRecord(assistant) || assistant.type !== 'text_delta') return undefined;
  if (typeof assistant.delta !== 'string') throw new Error('Pi text delta is malformed');
  return assistant.delta;
}

export function isPiAssistantMessageEnd(line: string): boolean {
  const event = parseHarnessEvent(line, 'Pi');
  return event?.type === 'message_end' && isRecord(event.message) && event.message.role === 'assistant';
}

function parseOpenCodeForwarded(line: string, prefix: string, label: string): Record<string, unknown> {
  let forwarded: unknown;
  try {
    forwarded = JSON.parse(line.slice(prefix.length)) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (!isRecord(forwarded) || forwarded.version !== 1 || typeof forwarded.sessionID !== 'string') {
    throw new Error(`${label} is malformed`);
  }
  return forwarded;
}

export function extractOpenCodeTextDelta(line: string, expectedSessionId?: string): string | undefined {
  if (byteLength(line) > MAX_HARNESS_EVENT_BYTES) throw new Error('OpenCode event exceeds its byte limit');
  if (line.startsWith(OPENCODE_TEXT_DELTA_PREFIX)) {
    const forwarded = parseOpenCodeForwarded(
      line,
      OPENCODE_TEXT_DELTA_PREFIX,
      'OpenCode forwarded text delta',
    );
    if (typeof forwarded.delta !== 'string') throw new Error('OpenCode forwarded text delta is malformed');
    if (expectedSessionId && forwarded.sessionID !== expectedSessionId) return undefined;
    return forwarded.delta;
  }

  const event = parseHarnessEvent(line, 'OpenCode');
  if (!event) return undefined;
  if (event.type === 'message.part.delta') {
    const properties = event.properties;
    if (!isRecord(properties) || properties.field !== 'text' || typeof properties.delta !== 'string') return undefined;
    if (expectedSessionId && properties.sessionID !== expectedSessionId) return undefined;
    return properties.delta;
  }
  if (event.type === 'text') {
    if (expectedSessionId) return undefined;
    const part = event.part;
    if (!isRecord(part) || typeof part.text !== 'string') throw new Error('OpenCode text event is malformed');
    return part.text;
  }
  return undefined;
}

export function isOpenCodeTextEnd(line: string, expectedSessionId: string): boolean {
  if (!line.startsWith(OPENCODE_TEXT_END_PREFIX)) return false;
  if (byteLength(line) > MAX_HARNESS_EVENT_BYTES) throw new Error('OpenCode text-end event exceeds its byte limit');
  const forwarded = parseOpenCodeForwarded(line, OPENCODE_TEXT_END_PREFIX, 'OpenCode text-end event');
  return forwarded.sessionID === expectedSessionId;
}

export interface ReviewEventSink {
  accept(event: ReviewEvent): Promise<unknown>;
}

export type ReviewBackendOutputConsumerInput =
  | { backend: 'pi'; sink: ReviewEventSink }
  | { backend: 'opencode'; sink: ReviewEventSink; sessionId: string };

export class ReviewBackendOutputConsumer {
  #proseLines = 0;
  get proseLineCount(): number {
    return this.#proseLines;
  }
  readonly #backend: 'pi' | 'opencode';
  readonly #sink: ReviewEventSink;
  readonly #sessionId: string | undefined;
  readonly #parser = new ReviewEventStreamParser();
  #terminalFailure: string | undefined;
  readonly #openCodeCoordinatorMessages = new Set<string>();
  readonly #openCodeTerminals = new Map<string, { reason: string; sequence: number }>();
  #openCodeTerminalSequence = 0;

  get terminalFailure(): string | undefined {
    return this.#terminalFailure;
  }

  constructor(input: ReviewBackendOutputConsumerInput) {
    if (input.backend === 'opencode' && input.sessionId.length === 0) {
      throw new Error('OpenCode reporting requires the coordinator session id');
    }
    this.#backend = input.backend;
    this.#sink = input.sink;
    this.#sessionId = input.backend === 'opencode' ? input.sessionId : undefined;
  }

  get completed(): boolean {
    return this.#parser.completed;
  }

  async pushHarnessLine(line: string): Promise<void> {
    if (this.#backend === 'pi') {
      const delta = extractPiTextDelta(line);
      if (delta !== undefined) await this.#deliver(this.#parser.push(delta));
      else if (isPiAssistantMessageEnd(line)) {
        const event = parseHarnessEvent(line, 'Pi');
        const message = event?.message;
        if (isRecord(message) && typeof message.stopReason === 'string') {
          // JSON-mode Pi may exit zero after provider failure. Retain only a
          // fixed reason, never raw provider text that could contain a secret.
          this.#terminalFailure = message.stopReason === 'stop'
            ? undefined
            : `Pi assistant ended with ${['error', 'aborted', 'length', 'toolUse'].includes(message.stopReason)
                ? message.stopReason
                : 'an unsupported terminal reason'}`;
        }
        await this.#deliver(this.#parser.finishSegment());
      }
      return;
    }

    const sessionId = this.#sessionId as string;
    if (line.startsWith(OPENCODE_TEXT_DELTA_PREFIX)) {
      const delta = extractOpenCodeTextDelta(line, sessionId);
      if (delta !== undefined) {
        this.#observeOpenCodeCoordinator(line, OPENCODE_TEXT_DELTA_PREFIX);
        await this.#deliver(this.#parser.push(delta));
      }
    } else if (isOpenCodeTextEnd(line, sessionId)) {
      this.#observeOpenCodeCoordinator(line, OPENCODE_TEXT_END_PREFIX);
      await this.#deliver(this.#parser.finishSegment());
    } else if (!line.startsWith(OPENCODE_TEXT_END_PREFIX)) {
      const event = parseHarnessEvent(line, 'OpenCode');
      if (event?.type === 'step_finish') {
        const part = event.part;
        if (!isRecord(part) || typeof part.messageID !== 'string' ||
            part.messageID.length === 0 || part.messageID.length > 256 ||
            typeof part.reason !== 'string') throw new Error('OpenCode terminal event is malformed');
        if (!this.#openCodeTerminals.has(part.messageID) && this.#openCodeTerminals.size >= 1024) {
          throw new Error('OpenCode terminal message limit exceeded');
        }
        // The plugin reports a fixed coordinator alias, while native CLI events
        // use a generated session ID. Bind their terminal state by the original
        // assistant message ID, never by the first unrelated native session.
        const reason = ['stop', 'length', 'error', 'tool-calls', 'content-filter'].includes(part.reason)
          ? part.reason : 'an unsupported terminal reason';
        this.#openCodeTerminals.set(part.messageID, { reason, sequence: ++this.#openCodeTerminalSequence });
        this.#updateOpenCodeTerminal();
      }
    }
  }

  #observeOpenCodeCoordinator(line: string, prefix: string): void {
    const forwarded = parseOpenCodeForwarded(line, prefix, 'OpenCode coordinator message');
    if (forwarded.messageID === undefined) return;
    if (typeof forwarded.messageID !== 'string' || forwarded.messageID.length === 0 || forwarded.messageID.length > 256) {
      throw new Error('OpenCode coordinator message identity is malformed');
    }
    if (!this.#openCodeCoordinatorMessages.has(forwarded.messageID) && this.#openCodeCoordinatorMessages.size >= 1024) {
      throw new Error('OpenCode coordinator message limit exceeded');
    }
    this.#openCodeCoordinatorMessages.add(forwarded.messageID);
    this.#updateOpenCodeTerminal();
  }

  #updateOpenCodeTerminal(): void {
    let latest: { reason: string; sequence: number } | undefined;
    for (const messageID of this.#openCodeCoordinatorMessages) {
      const terminal = this.#openCodeTerminals.get(messageID);
      if (terminal && (!latest || terminal.sequence > latest.sequence)) latest = terminal;
    }
    if (latest) this.#terminalFailure = latest.reason === 'stop'
      ? undefined : `OpenCode assistant ended with ${latest.reason}`;
  }

  async finish(): Promise<void> {
    await this.#deliver(this.#parser.finish());
  }

  #unsupportedLines = 0;
  get unsupportedLineCount(): number {
    return this.#unsupportedLines;
  }

  #firstProseLine: string | undefined;
  get firstProseLine(): string | undefined {
    return this.#firstProseLine;
  }

  async #deliver(results: readonly ReviewEventParseResult[]): Promise<void> {
    const errors: unknown[] = [];
    for (const result of results) {
      if (!result.ok) {
        if (result.prose) {
          this.#proseLines += 1;
          this.#firstProseLine ??= result.lineText.slice(0, 2048);
          continue;
        }
        if (result.unsupportedType) {
          this.#unsupportedLines += 1;
          continue;
        }
        errors.push(new Error(`${result.error.message} [line: ${result.lineText.slice(0, 512)}]`));
        continue;
      }
      try {
        await this.#sink.accept(result.event);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'review events were rejected');
  }
}
