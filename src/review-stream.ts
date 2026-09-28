import {
  MAX_REVIEW_EVENT_LINE_BYTES,
  MAX_REVIEW_EVENT_STREAM_BYTES,
  MAX_REVIEW_FINDINGS,
  parseReviewEvent,
  type ReviewEvent,
} from './review-report.js';
import { byteLength, isRecord } from './review-bundle.js';

export const OPENCODE_TEXT_DELTA_PREFIX = 'REDLINE_REVIEW_TEXT_DELTA ';
const MAX_HARNESS_EVENT_BYTES = 1024 * 1024;

export class ReviewEventStreamParser {
  #buffer = '';
  #bytes = 0;
  #findingCount = 0;
  #completed = false;

  get completed(): boolean {
    return this.#completed;
  }

  push(text: string): ReviewEvent[] {
    this.#bytes += byteLength(text);
    if (this.#bytes > MAX_REVIEW_EVENT_STREAM_BYTES) throw new Error('review event stream exceeds its byte limit');
    this.#buffer += text;
    if (byteLength(this.#buffer) > MAX_REVIEW_EVENT_LINE_BYTES && !this.#buffer.includes('\n')) {
      throw new Error('review event line exceeds its byte limit');
    }

    const events: ReviewEvent[] = [];
    while (true) {
      const newline = this.#buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.#buffer.slice(0, newline).replace(/\r$/u, '');
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length === 0) continue;
      events.push(this.#parseLine(line));
    }
    return events;
  }

  finish(): ReviewEvent[] {
    if (this.#buffer.length === 0) return [];
    const line = this.#buffer.replace(/\r$/u, '');
    this.#buffer = '';
    if (line.length === 0) return [];
    return [this.#parseLine(line)];
  }

  #parseLine(line: string): ReviewEvent {
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
    return event;
  }
}

export function extractPiTextDelta(line: string): string | undefined {
  if (byteLength(line) > MAX_HARNESS_EVENT_BYTES) throw new Error('Pi event exceeds its byte limit');
  let event: unknown;
  try {
    event = JSON.parse(line) as unknown;
  } catch {
    throw new Error('Pi event is not valid JSON');
  }
  if (!isRecord(event) || event.type !== 'message_update') return undefined;
  const assistant = event.assistantMessageEvent;
  if (!isRecord(assistant) || assistant.type !== 'text_delta') return undefined;
  if (typeof assistant.delta !== 'string') throw new Error('Pi text delta is malformed');
  return assistant.delta;
}

export function extractOpenCodeTextDelta(line: string, expectedSessionId?: string): string | undefined {
  if (byteLength(line) > MAX_HARNESS_EVENT_BYTES) throw new Error('OpenCode event exceeds its byte limit');
  if (line.startsWith(OPENCODE_TEXT_DELTA_PREFIX)) {
    let forwarded: unknown;
    try {
      forwarded = JSON.parse(line.slice(OPENCODE_TEXT_DELTA_PREFIX.length)) as unknown;
    } catch {
      throw new Error('OpenCode forwarded text delta is not valid JSON');
    }
    if (
      !isRecord(forwarded) ||
      forwarded.version !== 1 ||
      typeof forwarded.sessionID !== 'string' ||
      typeof forwarded.delta !== 'string'
    ) {
      throw new Error('OpenCode forwarded text delta is malformed');
    }
    if (expectedSessionId && forwarded.sessionID !== expectedSessionId) return undefined;
    return forwarded.delta;
  }

  let event: unknown;
  try {
    event = JSON.parse(line) as unknown;
  } catch {
    throw new Error('OpenCode event is not valid JSON');
  }
  if (!isRecord(event)) return undefined;
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
    if (this.#backend === 'opencode' && !line.startsWith(OPENCODE_TEXT_DELTA_PREFIX)) return;
    const delta =
      this.#backend === 'pi'
        ? extractPiTextDelta(line)
        : extractOpenCodeTextDelta(line, this.#sessionId);
    if (delta === undefined) return;
    for (const event of this.#parser.push(delta)) await this.#sink.accept(event);
  }

  async finish(): Promise<void> {
    for (const event of this.#parser.finish()) await this.#sink.accept(event);
  }
}
