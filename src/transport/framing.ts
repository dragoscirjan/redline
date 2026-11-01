import type { Writable } from 'node:stream';
export const FRAME_LIMITS = Object.freeze({
  headerBytes: 1024, messageBytes: 1024 * 1024, queueBytes: 2 * 1024 * 1024,
  queueMessages: 32, writeTimeoutMs: 5_000,
});
const LIMITS = FRAME_LIMITS;

/** Framing failures are fatal: there is no safe boundary to resynchronize on. */
export class FramingError extends Error {}
export function frame(value: unknown): Buffer {
  const json = JSON.stringify(value);
  const bytes = Buffer.from(json, 'utf8');
  if (bytes.length > LIMITS.messageBytes) throw new FramingError('Message exceeds byte limit');
  return Buffer.concat([Buffer.from('Content-Length: ' + bytes.length + '\r\n\r\n', 'ascii'), bytes]);
}
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0);
  private length: number | undefined;
  get pending(): boolean { return this.buffer.length > 0 || this.length !== undefined; }
  push(chunk: Buffer): Buffer[] {
    // Node input chunks can be larger than one frame. Consume them in bounded slices.
    const messages: Buffer[] = [];
    let messageBytes = 0;
    for (let offset = 0; offset < chunk.length;) {
      const room = (this.length ?? LIMITS.headerBytes) - this.buffer.length;
      if (room <= 0) throw new FramingError('Header exceeds byte limit');
      const count = Math.min(room, chunk.length - offset);
      this.buffer = Buffer.concat([this.buffer, chunk.subarray(offset, offset + count)]);
      offset += count;
      if (this.length === undefined) {
        const end = this.buffer.indexOf('\r\n\r\n');
        if (end === -1) {
          if (this.buffer.length >= LIMITS.headerBytes) throw new FramingError('Header exceeds byte limit');
          continue;
        }
        const raw = this.buffer.subarray(0, end);
        if (raw.some(byte => byte < 32 || byte > 126)) throw new FramingError('Non-ASCII header');
        const header = raw.toString('ascii');
        const match = /^Content-Length: ([1-9][0-9]{0,6})$/iu.exec(header);
        if (match === null) throw new FramingError('Invalid Content-Length header');
        const length = Number(match[1]);
        if (length > LIMITS.messageBytes) throw new FramingError('Message exceeds byte limit');
        this.length = length;
        this.buffer = this.buffer.subarray(end + 4);
      }
      while (this.length !== undefined && this.buffer.length >= this.length) {
        if (messages.length >= LIMITS.queueMessages) throw new FramingError('Too many buffered messages');
        if (messageBytes + this.length > LIMITS.queueBytes) throw new FramingError('Buffered message byte limit');
        messageBytes += this.length;
        messages.push(Buffer.from(this.buffer.subarray(0, this.length)));
        const rest: Buffer = this.buffer.subarray(this.length);
        this.length = undefined; this.buffer = Buffer.alloc(0);
        if (rest.length > 0) {
          const more = this.push(rest);
          messageBytes += more.reduce((total, body) => total + body.length, 0);
          if (messageBytes > LIMITS.queueBytes) throw new FramingError('Buffered message byte limit');
          messages.push(...more);
        }
      }
    }
    if (messages.length > LIMITS.queueMessages) throw new FramingError('Too many buffered messages');
    return messages;
  }
  end(): void { if (this.pending) throw new FramingError('Truncated message'); }
}
export class FrameWriter {
  private readonly output: Writable;
  private readonly failed: () => void;
  private tail: Promise<void> = Promise.resolve();
  private bytes = 0;
  private messages = 0;
  private closed = false;
  constructor(output: Writable, failed: () => void) {
    this.output = output; this.failed = failed;
    output.on('error', this.onError);
    output.on('close', this.onClose);
  }
  private readonly onError = (): void => {
    if (!this.closed) {
      this.closed = true;
      // A stalled libuv pipe write otherwise keeps the process alive after its deadline.
      this.output.destroy();
      this.failed();
    }
  };
  private readonly onClose = (): void => this.onError();
  send(value: unknown, optional = false): boolean {
    if (this.closed) return false;
    const bytes = frame(value);
    if (optional && (this.messages >= LIMITS.queueMessages / 2 || this.bytes + bytes.length > LIMITS.queueBytes / 2)) return false;
    if (this.messages >= LIMITS.queueMessages || this.bytes + bytes.length > LIMITS.queueBytes) {
      if (!optional) this.onError();
      return false;
    }
    this.messages++; this.bytes += bytes.length;
    this.tail = this.tail.then(() => new Promise<void>((resolve, reject) => {
      if (this.closed) { reject(new Error('Output unavailable')); return; }
      const timer = setTimeout(() => reject(new Error('Output stalled')), LIMITS.writeTimeoutMs);
      this.output.write(bytes, error => {
        clearTimeout(timer);
        if (error) reject(error); else resolve();
      });
    })).catch(() => this.onError()).finally(() => { this.messages--; this.bytes -= bytes.length; });
    return true;
  }
  async flush(): Promise<void> { await this.tail; }
  dispose(): void { this.closed = true; this.output.removeListener('error', this.onError); this.output.removeListener('close', this.onClose); }
}
