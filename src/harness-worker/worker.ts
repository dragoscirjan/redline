import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createPiExecutor } from '../harness-executor/pi-executor.ts';
import { createOpenCodeExecutor } from '../harness-executor/opencode-executor.ts';
import { cancellableSpawner } from '../local/process.ts';
import type { HarnessRun, HarnessSettings } from '../harness-executor/types.ts';
import { FrameReader, FrameWriter } from '../transport/framing.ts';
import { chunks, decodeData, identityValid, LIMITS, parseHostMessage, parseJson, parseWorkerMessage, PROTOCOL, readPrompt, WorkerFault,
  type Identity, type Invocation, type WorkerMessage } from './contract.ts';
import { ModelRelay } from './relay.ts';

async function sandbox(): Promise<void> {
  if (process.platform !== 'linux' || process.getuid?.() !== 10001 || process.getgid?.() !== 10001) throw new WorkerFault('Worker identity policy failed');
  const status = await readFile('/proc/self/status', 'utf8');
  if (!/^NoNewPrivs:\s+1$/mu.test(status) || !/^Seccomp:\s+2$/mu.test(status) || !/^CapEff:\s+0+$/mu.test(status)) throw new WorkerFault('Worker kernel policy failed');
  if (Object.entries(networkInterfaces()).some(([name, addresses]) => name !== 'lo' && addresses?.some(a => !a.internal))) throw new WorkerFault('Worker network policy failed');
}

/** Private image process. No source path, executable, image or real credential comes from the wire. */
export async function main(): Promise<number> {
  const controller = new AbortController();
  const reader = new FrameReader();
  const writer = new FrameWriter(process.stdout, () => controller.abort());
  const stop = (): void => { controller.abort(); process.stdin.destroy(); };
  controller.signal.addEventListener('abort', () => process.stdin.destroy(), { once: true });
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(stop, LIMITS.frameTimeoutMs);
  let frameTimer: ReturnType<typeof setTimeout> | undefined;
  let invocation: Invocation | undefined;
  let identity: Identity | undefined;
  let relay: ModelRelay | undefined;
  let execution: Promise<void> | undefined;
  let directory: string | undefined;
  let inputBytes = 0;
  const input: Buffer[] = [];
  let invoked = false;
  let completed = false;
  const send = async (message: WorkerMessage): Promise<void> => {
    parseWorkerMessage(message);
    if (controller.signal.aborted || !writer.send(message)) throw new WorkerFault('Worker channel unavailable');
    await writer.flush();
    if (controller.signal.aborted) throw new WorkerFault('Worker channel unavailable');
  };
  try {
    await sandbox();
    const profile = parseJson(await readFile(new URL('../../worker.json', import.meta.url)));
    if (!identityValid(profile)) throw new WorkerFault('Worker profile unavailable');
    identity = profile;
    await mkdir('/tmp/redline', { recursive: true, mode: 0o700 });
    directory = await mkdtemp('/tmp/redline/invocation-');
    await send({ protocol: PROTOCOL, kind: 'hello', identity });
    for await (const part of process.stdin) {
      const wasPending = reader.pending;
      const messages = reader.push(Buffer.from(part));
      if (!reader.pending || !wasPending || messages.length > 0) {
        clearTimeout(frameTimer); frameTimer = undefined;
        if (reader.pending) frameTimer = setTimeout(stop, LIMITS.frameTimeoutMs);
      }
      for (const bytes of messages) {
        const message = parseHostMessage(parseJson(bytes));
        if (message.kind === 'invoke') {
          if (invocation !== undefined || message.harness !== identity.harness) throw new WorkerFault();
          invocation = message; clearTimeout(timer); timer = setTimeout(stop, message.timeoutMs);
          continue;
        }
        if (invocation === undefined || message.jobId !== invocation.jobId || completed) throw new WorkerFault();
        if (message.kind === 'input') {
          if (invoked) throw new WorkerFault();
          const data = decodeData(message.data); inputBytes += data.length;
          if (inputBytes > LIMITS.payloadBytes) throw new WorkerFault();
          input.push(data); continue;
        }
        if (message.kind === 'cancel') { stop(); continue; }
        if (message.kind === 'input.end') {
          if (invoked || directory === undefined) throw new WorkerFault();
          invoked = true;
          const prompt = readPrompt(Buffer.concat(input)); input.length = 0;
          const invocationRoot = directory;
          const request = invocation;
          relay = new ModelRelay(request.jobId, send, controller.signal);
          const modelRelay = relay;
          execution = (async () => {
            await modelRelay.listen();
            const settings: HarnessSettings = {
              model: { ...request.model, endpoint: modelRelay.endpoint },
              credential: { provider: request.model.provider, value: 'redline-worker-local' },
              timeoutMs: request.timeoutMs, workDirectory: invocationRoot,
              ...(request.retryOwnership === 'caller' ? { retryOwnership: 'caller' as const } : {}),
              modelProtocol: request.modelProtocol,
              ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
            };
            const executor = request.harness === 'pi'
              ? createPiExecutor({ command: process.execPath, spawner: cancellableSpawner(controller.signal,
                { command: process.execPath, prefix: ['/opt/harness/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'] }) })
              : createOpenCodeExecutor({ command: '/opt/harness/opencode-bin', spawner: {
                spawn: value => cancellableSpawner(controller.signal).spawn({ ...value, env: { ...value.env,
                  OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', DO_NOT_TRACK: '1' } }),
              } });
            const prepared = await executor.prepare(settings);
            let tappedBytes = 0;
            let run: HarnessRun = await executor.execute(prepared, prompt, { timeoutMs: request.timeoutMs, streamMode: request.streamMode ?? 'off',
              ...(request.streamMode === undefined || request.streamMode === 'off' ? {} : { onOutputLine: output => {
                const bytes = Buffer.from(Array.from(output.line).slice(0, 16_000).join(''));
                tappedBytes += bytes.length;
                if (bytes.length > 0 && tappedBytes <= LIMITS.outputBytes + LIMITS.diagnosticBytes) writer.send({ protocol: PROTOCOL, kind: 'tap', jobId: request.jobId,
                  stream: output.stream, tapKind: output.kind, data: bytes.toString('base64') }, true);
              } }),
            });
            if (modelRelay.limitExceeded) run = { ...run, status: 'failed', retryable: false, text: '', diagnostic: 'Worker model response exceeded its byte limit' };
            const { text, diagnostic, ...metadata } = run;
            if (metadata.harness !== request.harness) throw new WorkerFault();
            for (const data of chunks(Buffer.from(text))) await send({ protocol: PROTOCOL, kind: 'output', jobId: request.jobId, stream: 'text', data });
            for (const data of chunks(Buffer.from(diagnostic))) await send({ protocol: PROTOCOL, kind: 'output', jobId: request.jobId, stream: 'diagnostic', data });
            await send({ protocol: PROTOCOL, kind: 'result', jobId: request.jobId, run: { ...metadata, harness: request.harness } });
            completed = true; stop();
          })().catch(() => stop());
          continue;
        }
        if (!invoked || relay === undefined) throw new WorkerFault();
        await relay.receive(message);
      }
    }
    if (!completed) reader.end();
    return completed ? 0 : 1;
  } catch {
    process.stderr.write('redline worker: invocation unavailable\n');
    return 1;
  } finally {
    clearTimeout(timer); clearTimeout(frameTimer); stop();
    await relay?.close(); await execution;
    await writer.flush(); writer.dispose();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}
