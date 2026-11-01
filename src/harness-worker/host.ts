import type { Readable, Writable } from 'node:stream';
import type { HarnessPrompt, HarnessRun, HarnessSettings, HarnessOutputLine, HarnessStreamMode } from '../harness-executor/types.ts';
import { outputCaptureBytes } from '../harness-executor/output-budget.ts';
import { FrameReader, FrameWriter } from '../transport/framing.ts';
import { chunks, decodeData, identityValid, invocationMessages, LIMITS, parseHostMessage, parseJson, parseWorkerMessage, WorkerFault,
  type Accept, type HostMessage, type Identity } from './contract.ts';
import type { ModelBroker } from './broker.ts';

export interface WorkerJob {
  readonly input: Readable;
  readonly output: Writable;
  /** Matched to the trusted image manifest by the container adapter, never learned from hello. */
  readonly identity: Identity;
  readonly settings: HarnessSettings;
  readonly prompt: HarnessPrompt;
  readonly broker: ModelBroker;
  readonly streamMode?: HarnessStreamMode;
  readonly onOutputLine?: (output: HarnessOutputLine) => void;
}
/** Owns one invocation's byte channel. The container/process owner still must reap its worker. */
export async function runWorkerJob(job: WorkerJob): Promise<HarnessRun> {
  const { input, output, identity, broker } = job;
  const reader = new FrameReader();
  let failed = false;
  const stop = (): void => { failed = true; input.destroy(); output.destroy(); };
  const writer = new FrameWriter(output, () => { broker.close(); stop(); });
  let frameTimer: ReturnType<typeof setTimeout> | undefined;
  let transfer: Promise<void> | undefined;
  let active: { id: number; accept: Accept; body: Buffer[]; bytes: number } | undefined;
  let requests = 0;
  let terminalRequest = 0;
  let ready = false;
  const text: Buffer[] = []; const diagnostic: Buffer[] = [];
  let textBytes = 0; let diagnosticBytes = 0; let tapBytes = 0;
  const send = async (message: HostMessage): Promise<void> => {
    parseHostMessage(message);
    if (failed || !writer.send(message)) throw new WorkerFault('Worker output unavailable');
    await writer.flush();
    if (failed) throw new WorkerFault('Worker output unavailable');
  };
  broker.signal.addEventListener('abort', stop, { once: true });
  try {
    if (!identityValid(identity) || broker.model !== job.settings.model.model) throw new WorkerFault('Invalid worker job');
    if (broker.signal.aborted) throw new WorkerFault('Worker job stopped');
    for await (const chunk of input) {
      if (!(chunk instanceof Uint8Array)) throw new WorkerFault();
      const pending = reader.pending;
      const messages = reader.push(Buffer.from(chunk));
      if (!reader.pending || !pending || messages.length > 0) {
        clearTimeout(frameTimer); frameTimer = undefined;
        if (reader.pending) frameTimer = setTimeout(() => { broker.close(); stop(); }, LIMITS.frameTimeoutMs);
      }
      for (const bytes of messages) {
        if (failed) throw new WorkerFault('Worker job stopped');
        const message = parseWorkerMessage(parseJson(bytes));
        if (!ready) {
          if (message.kind !== 'hello' || (['harness', 'release', 'revision', 'harnessVersion'] as const).some(key => message.identity[key] !== identity[key])) {
            throw new WorkerFault('Worker identity mismatch');
          }
          for (const invocation of invocationMessages(identity.harness, broker.jobId, job.settings, job.prompt, job.onOutputLine === undefined ? 'off' : job.streamMode ?? 'text')) await send(invocation);
          ready = true; continue;
        }
        if (message.kind === 'hello' || message.jobId !== broker.jobId) throw new WorkerFault();
        switch (message.kind) {
          case 'request.start':
            if (active !== undefined || message.requestId !== requests + 1) throw new WorkerFault();
            if (transfer !== undefined) {
              if (terminalRequest !== requests) throw new WorkerFault();
              await transfer;
              if (failed) throw new WorkerFault('Worker job stopped');
            }
            active = { id: message.requestId, accept: message.accept, body: [], bytes: 0 }; break;
          case 'request.data': {
            if (active === undefined || message.requestId !== active.id) throw new WorkerFault();
            const bytes = decodeData(message.data);
            active.bytes += bytes.length;
            if (active.bytes > LIMITS.payloadBytes) throw new WorkerFault('Worker request exceeds byte limit');
            active.body.push(bytes); break;
          }
          case 'request.end': {
            if (active === undefined || message.requestId !== active.id) throw new WorkerFault();
            const request = active; active = undefined; requests++;
            transfer = (async () => {
              for await (const response of broker.request(request.id, Buffer.concat(request.body), request.accept)) {
                // A peer can receive the terminal frame before our write callback settles.
                if (response.kind === 'response.end' || response.kind === 'response.error') terminalRequest = request.id;
                await send(response);
              }
            })().then(() => { transfer = undefined; }, () => { broker.close(); stop(); });
            break;
          }
          case 'tap': {
            const bytes = decodeData(message.data); tapBytes += bytes.length;
            if (tapBytes <= outputCaptureBytes(job.settings.maxOutputTokens) + LIMITS.diagnosticBytes) {
              job.onOutputLine?.({ stream: message.stream, kind: message.tapKind,
                line: broker.redact(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) });
            }
            break;
          }
          case 'output': {
            const bytes = decodeData(message.data);
            if (message.stream === 'text') {
              textBytes += bytes.length;
              if (textBytes > outputCaptureBytes(job.settings.maxOutputTokens)) throw new WorkerFault('Worker result exceeds byte limit');
              text.push(bytes);
            } else {
              diagnosticBytes += bytes.length;
              if (diagnosticBytes > LIMITS.diagnosticBytes) throw new WorkerFault('Worker diagnostic exceeds byte limit');
              diagnostic.push(bytes);
            }
            break;
          }
          case 'result': {
            if (active !== undefined || message.run.harness !== identity.harness) throw new WorkerFault();
            if (transfer !== undefined) {
              if (terminalRequest !== requests) throw new WorkerFault();
              await transfer;
              if (failed) throw new WorkerFault('Worker job stopped');
            }
            const decoder = new TextDecoder('utf-8', { fatal: true });
            return { ...message.run, text: broker.redact(decoder.decode(Buffer.concat(text))),
              diagnostic: broker.redact(decoder.decode(Buffer.concat(diagnostic))) };
          }
        }
      }
    }
    reader.end();
    throw new WorkerFault('Worker disconnected before result');
  } catch (error) {
    // Protocol faults contain fixed local messages, never worker or native error text.
    if (error instanceof WorkerFault) throw error;
    throw new WorkerFault('Worker invocation failed');
  } finally {
    clearTimeout(frameTimer);
    broker.signal.removeEventListener('abort', stop);
    broker.close(); input.destroy(); output.destroy();
    await transfer;
    await writer.flush(); writer.dispose();
  }
}

/** Small helper for the image bootstrap and conformance clients; it grants no host authority. */
export function* outputMessages(jobId: string, stream: 'text' | 'diagnostic', bytes: Buffer) {
  for (const data of chunks(bytes)) yield { protocol: 'redline-worker/v1', kind: 'output', jobId, stream, data } as const;
}
