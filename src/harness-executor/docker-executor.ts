import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ModelBroker } from '../harness-worker/broker.ts';
import { runWorkerJob } from '../harness-worker/host.ts';
import { containerArguments, type ContainerLimits, type DockerClient } from '../harness-worker/docker-client.ts';
import type { WorkerImage } from '../harness-worker/images.ts';
import { WorkerFault, type WorkerHarness } from '../harness-worker/contract.ts';
import type { HarnessExecutor, HarnessPrompt, HarnessRun, HarnessSettings, HarnessExecuteOptions, PreparedHarness } from './types.ts';

interface PreparedDocker extends PreparedHarness { readonly settings: HarnessSettings }
export function createDockerExecutor(harness: WorkerHarness, client: DockerClient, image: WorkerImage, limits: ContainerLimits,
  signal: AbortSignal, warning: (message: string) => void = () => {}): HarnessExecutor {
  return {
    harness,
    async prepare(settings): Promise<PreparedDocker> {
      if (settings.modelProtocol === 'openrouter-json' && (harness !== 'pi' || settings.model.provider !== 'openrouter')) throw new Error('openrouter-json requires Pi and OpenRouter');
      return Object.freeze({ harness, model: settings.model, settings,
        description: `${harness} in a fresh restricted container; image=${image.reference}; worker=${image.identity.harnessVersion}` });
    },
    async execute(prepared: PreparedHarness, prompt: HarnessPrompt, options?: HarnessExecuteOptions): Promise<HarnessRun> {
      const state = prepared as PreparedDocker;
      const timeoutMs = options?.timeoutMs ?? state.settings.timeoutMs;
      const started = performance.now();
      const jobId = randomUUID(); const name = 'redline-' + jobId;
      const settings = { ...state.settings, timeoutMs };
      const maxTokens = settings.maxOutputTokens ?? (harness === 'pi' ? 16_384 : undefined);
      const broker = new ModelBroker({ jobId, model: settings.model.model,
        url: settings.model.endpoint.replace(/\/+$/u, '') + '/chat/completions',
        credential: settings.credential?.value, timeoutMs, signal,
        maxRequests: harness === 'opencode' ? 6 : settings.retryOwnership === 'caller' ? 1 : 2,
        ...(maxTokens === undefined ? {} : { maxOutputTokens: maxTokens }) });
      let identifier = name;
      let creationAttempted = false;
      let attached: ReturnType<DockerClient['attach']> | undefined;
      try {
        signal.throwIfAborted(); creationAttempted = true;
        const id = await client.run(containerArguments(image, client.owner, jobId, timeoutMs, limits), broker.signal,
          Math.min(30_000, timeoutMs));
        if (!/^[0-9a-f]{64}$/u.test(id)) throw new Error('Invalid created container identifier');
        identifier = id;
        attached = client.attach(id);
        const setupMs = performance.now() - started;
        const run = await runWorkerJob({ input: attached.child.stdout, output: attached.child.stdin, identity: image.identity, settings, prompt, broker,
          ...(options?.onOutputLine === undefined ? {} : { onOutputLine: options.onOutputLine }),
          ...(options?.streamMode === undefined ? {} : { streamMode: options.streamMode }) });
        return { ...run, durationMs: performance.now() - started,
          ...(run.telemetry === undefined ? {} : { telemetry: { ...run.telemetry,
            processStartupMs: setupMs + (run.telemetry.processStartupMs ?? 0),
            timeToFirstTextMs: run.telemetry.timeToFirstTextMs === null ? null : setupMs + run.telemetry.timeToFirstTextMs } }) };
      } catch (error) {
        const detail = error instanceof WorkerFault ? broker.redact(error.message) : 'Worker transport unavailable';
        return { harness, status: broker.timedOut && !signal.aborted ? 'timed-out' : 'failed', exitCode: null,
          text: '', diagnostic: signal.aborted ? 'Container invocation cancelled' : broker.timedOut ? 'Container invocation deadline exhausted' : 'Container worker failed; no direct-execution fallback. ' + detail,
          retryable: false, durationMs: performance.now() - started };
      } finally {
        broker.close();
        if (creationAttempted) await client.remove(identifier, jobId).catch(() => warning('Container cleanup failed; model access was revoked. Owned expired resources will be reconciled.'));
        if (attached !== undefined) {
          attached.child.kill('SIGKILL');
          let timer: ReturnType<typeof setTimeout> | undefined;
          try { await Promise.race([attached.exit.catch(() => null), new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]); }
          finally { clearTimeout(timer); }
        }
      }
    },
  };
}
