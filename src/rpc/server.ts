import type { Readable, Writable } from 'node:stream';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { CODES, LIMITS } from './contract.ts';
import { FrameReader, FrameWriter, FramingError } from './framing.ts';
import { Session } from './session.ts';
import type { Execute } from './local.ts';

export interface ServerOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly execute: Execute;
  readonly once?: boolean;
  readonly signal?: AbortSignal;
  readonly onOutputFailure?: () => void;
}
/** No sockets, global logging, or process state. The CLI owns process shutdown. */
export async function serve(options: ServerOptions): Promise<number> {
  const reader = new FrameReader();
  let session: Session;
  let failed = false;
  let frameTimer: NodeJS.Timeout | undefined;
  const abort = (): void => { session?.stop(); options.input.destroy(); };
  const writer = new FrameWriter(options.output, () => { failed = true; options.onOutputFailure?.(); abort(); });
  session = new Session({ execute: options.execute, once: options.once === true, send: (value, optional) => writer.send(value, optional) });
  const partial = (): void => {
    if (!reader.pending && frameTimer !== undefined) { clearTimeout(frameTimer); frameTimer = undefined; }
    if (reader.pending && frameTimer === undefined) frameTimer = setTimeout(() => {
      failed = true; session.stop(); options.input.destroy(new FramingError('Frame deadline exhausted'));
    }, LIMITS.frameTimeoutMs);
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    for await (const chunk of options.input) {
      const messages = reader.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (messages.length > LIMITS.queueMessages || messages.reduce((sum, bytes) => sum + bytes.length, 0) > LIMITS.queueBytes) throw new FramingError('Input queue exceeds limit');
      partial();
      for (const bytes of messages) {
        let value: unknown;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        catch { session.error(null, CODES.parse, 'Parse error'); await yieldTurn(); continue; }
        session.receive(value);
        await yieldTurn();
        if (session.closing) break;
      }
      if (session.closing) break;
    }
    if (!session.closing) reader.end();
  } catch {
    session.stop();
    if (!options.signal?.aborted) {
      failed = true;
      try { session.error(null, CODES.request, 'Invalid or incomplete stdio frame'); } catch { /* Output may already be closed. */ }
    }
  } finally {
    if (frameTimer !== undefined) clearTimeout(frameTimer);
    try {
      await session.end();
      await writer.flush();
    } finally {
      options.signal?.removeEventListener('abort', abort);
      writer.dispose();
    }
  }
  return failed ? 1 : options.signal?.aborted ? 130 : 0;
}
