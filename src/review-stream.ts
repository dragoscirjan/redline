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
  | { ok: false; error: Error };

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
      results.push(this.#parseLine(line));
    }
    return results;
  }

  finishSegment(): ReviewEventParseResult[] {
    if (this.#buffer.length === 0) return [];
    const line = this.#buffer.replace(/\r$/u, '');
    this.#buffer = '';
    if (line.length === 0) return [];
    return [this.#parseLine(line)];
  }

  finish(): ReviewEventParseResult[] {
    return this.finishSegment();
  }

  #parseLine(line: string): ReviewEventParseResult {
    try {
      if (byteLength(line) > MAX_REVIEW_EVENT_LINE_BYTES) throw new Error('review event line exceeds its byte limit');
      if (this.#completed) throw new Error('review event appears after completion');
      let decoded: unknown;
      try {
        decoded = JSON.parse(line) as unknown;
      } catch {
        throw new Error('review event line is not valid JSON');
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
      return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
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
  readonly #backend: 'pi' | 'opencode';
  readonly #sink: ReviewEventSink;
  readonly #sessionId: string | undefined;
  readonly #parser = new ReviewEventStreamParser();

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
      else if (isPiAssistantMessageEnd(line)) await this.#deliver(this.#parser.finishSegment());
      return;
    }

    const sessionId = this.#sessionId as string;
    if (line.startsWith(OPENCODE_TEXT_DELTA_PREFIX)) {
      const delta = extractOpenCodeTextDelta(line, sessionId);
      if (delta !== undefined) await this.#deliver(this.#parser.push(delta));
    } else if (isOpenCodeTextEnd(line, sessionId)) {
      await this.#deliver(this.#parser.finishSegment());
    }
  }

  async finish(): Promise<void> {
    await this.#deliver(this.#parser.finish());
  }

  async #deliver(results: readonly ReviewEventParseResult[]): Promise<void> {
    const errors: unknown[] = [];
    for (const result of results) {
      if (!result.ok) {
        errors.push(result.error);
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
