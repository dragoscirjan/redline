import { FrameReader, FrameWriter } from '../../../src/transport/framing.ts';
import { chunks, decodeData, parseHostMessage, parseJson, readPrompt, PROTOCOL, LIMITS, type Invocation, type WorkerMessage } from '../../../src/harness-worker/contract.ts';
import { outputMessages } from '../../../src/harness-worker/host.ts';

const writer = new FrameWriter(process.stdout, () => process.stdin.destroy());
const reader = new FrameReader();
async function send(message: WorkerMessage): Promise<void> {
  if (!writer.send(message)) throw new Error('fixture output closed');
  await writer.flush();
}
await send({ protocol: PROTOCOL, kind: 'hello', identity: {
  harness: 'pi', release: '1.1.0', revision: 'a'.repeat(40), harnessVersion: '1.4.0-fixture',
} });
let invocation: Invocation | undefined;
const input: Buffer[] = []; let inputBytes = 0;
const response: Buffer[] = []; let responseBytes = 0;
let mode = '';
try {
  for await (const chunk of process.stdin) {
    for (const bytes of reader.push(Buffer.from(chunk))) {
      const message = parseHostMessage(parseJson(bytes));
      if (message.kind === 'invoke') invocation = message;
      if (invocation === undefined || message.jobId !== invocation.jobId) throw new Error('fixture protocol');
      if (message.kind === 'input') {
        inputBytes += decodeData(message.data).length;
        if (inputBytes > LIMITS.payloadBytes) throw new Error('fixture input limit');
        input.push(decodeData(message.data));
      }
      if (message.kind === 'input.end') {
        const prompt = readPrompt(Buffer.concat(input)); mode = prompt.user;
        if (mode === 'hang') continue;
        if (mode === 'bad-version') { process.stdout.write('Content-Length: 1\r\n\r\nx'); continue; }
        const jobId = mode === 'wrong-job' ? '00000000-0000-4000-8000-000000000002' : invocation.jobId;
        await send({ protocol: PROTOCOL, kind: 'request.start', jobId, requestId: 1, accept: 'text/event-stream' });
        const body = Buffer.from(JSON.stringify({ model: mode === 'wrong-model' ? 'other' : invocation.model.model,
          messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
          max_tokens: invocation.maxOutputTokens ?? 16384, reasoning: { effort: 'high' }, stream: true }));
        for (const data of chunks(body)) await send({ protocol: PROTOCOL, kind: 'request.data', jobId, requestId: 1, data });
        await send({ protocol: PROTOCOL, kind: 'request.end', jobId, requestId: 1 });
      }
      if (message.kind === 'response.data') {
        responseBytes += decodeData(message.data).length;
        if (responseBytes > LIMITS.outputBytes) throw new Error('fixture response limit');
        response.push(decodeData(message.data));
      }
      if (message.kind === 'response.end' || message.kind === 'response.error') {
        for (const part of outputMessages(invocation.jobId, 'text', Buffer.concat(response))) await send(part);
        const diagnostic = Buffer.from(JSON.stringify({ input: Buffer.concat(input).toString(), invocation, environment: process.env }));
        for (const part of outputMessages(invocation.jobId, 'diagnostic', diagnostic)) await send(part);
        await send({ protocol: PROTOCOL, kind: 'result', jobId: invocation.jobId,
          run: { harness: 'pi', status: message.kind === 'response.end' ? 'succeeded' : 'failed', exitCode: 0, durationMs: 1,
            telemetry: { processStartupMs: 0, timeToFirstTextMs: 0, stdoutBytes: responseBytes, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false } } });
      }
      if (message.kind === 'cancel') process.stdin.destroy();
    }
  }
} catch { /* The parent deliberately closes hostile and cancelled probes. */ }
await writer.flush(); writer.dispose();
