import { randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { inside } from '../local/process.ts';
import { containerArguments, type ContainerLimits, type DockerClient } from './docker-client.ts';
import type { DockerImage } from './docker-client.ts';
import type { HarnessName } from './types.ts';
type WorkerHarness = Exclude<HarnessName, 'echo'>;
import type { ProcessSpawner, SpawnRequest } from '../process-runner.ts';
import { createPiExecutor } from './pi-executor.ts';
import { createOpenCodeExecutor } from './opencode-executor.ts';
import type { HarnessExecutor, HarnessExecuteOptions, HarnessPrompt, HarnessRun, PreparedHarness } from './types.ts';

interface PreparedDocker extends PreparedHarness { readonly inner: PreparedHarness; readonly workDirectory: string; readonly timeoutMs: number }
const INPUT = '/redline-input';
function executor(harness: WorkerHarness, spawner?: ProcessSpawner): HarnessExecutor {
  const options = { command: harness, ...(spawner === undefined ? {} : { spawner }) };
  return harness === 'pi' ? createPiExecutor(options) : createOpenCodeExecutor(options);
}
function generatedFile(source: string, destination: string, workDirectory: string): void {
  if (!inside(realpathSync(workDirectory), realpathSync(source))) throw new Error('Container config must be generated inside its trusted scratch directory');
  const handle = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(handle);
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Invalid generated harness config');
    const bytes = readFileSync(handle); if (bytes.length > 1024 * 1024) throw new Error('Harness config exceeds its bound');
    // Only this input directory is mounted. Its host parent stays private; files are readable by the container UID.
    writeFileSync(destination, bytes, { mode: 0o644 });
  } finally { closeSync(handle); }
}
function input(harness: WorkerHarness, request: SpawnRequest, directory: string, workDirectory: string): { args: readonly string[]; env: Record<string, string> } {
  if (request.command !== harness) throw new Error('Unexpected container executable');
  const env: Record<string, string> = {};
  if (harness === 'pi') {
    const root = request.env?.PI_CODING_AGENT_DIR;
    if (root === undefined) throw new Error('Missing generated Pi configuration');
    for (const name of ['models.json', 'settings.json', 'system-prompt.md']) generatedFile(join(root, name), join(directory, name), workDirectory);
    const policy = join(root, 'system-prompt.md');
    if (!request.args.includes(policy)) throw new Error('Missing fixed Pi policy');
    if (request.env?.REDLINE_MODEL_API_KEY !== undefined) env.REDLINE_MODEL_API_KEY = request.env.REDLINE_MODEL_API_KEY;
    return { args: request.args.map(arg => arg === policy ? INPUT + '/system-prompt.md' : arg), env };
  }
  const config = request.env?.OPENCODE_CONFIG;
  if (config === undefined) throw new Error('Missing generated OpenCode configuration');
  generatedFile(config, join(directory, 'opencode.json'), workDirectory);
  if (request.env?.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX !== undefined) env.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX = request.env.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX;
  return { args: request.args, env };
}
/** Docker changes process launch only. Existing SDK configuration, parsing and retry behavior stay authoritative. */
export function createDockerExecutor(harness: WorkerHarness, client: DockerClient, image: DockerImage, limits: ContainerLimits,
  signal: AbortSignal, warning: (message: string) => void = () => {}): HarnessExecutor {
  return {
    harness,
    async prepare(settings): Promise<PreparedDocker> {
      const inner = await executor(harness).prepare(settings);
      return Object.freeze({ harness, model: settings.model, inner, workDirectory: settings.workDirectory, timeoutMs: settings.timeoutMs,
        description: `${harness} command in Docker; image=${image.reference}` });
    },
    async execute(prepared: PreparedHarness, prompt: HarnessPrompt, options?: HarnessExecuteOptions): Promise<HarnessRun> {
      const state = prepared as PreparedDocker;
      const deadline = Date.now() + (options?.timeoutMs ?? state.timeoutMs);
      const jobs: { directory: string; reap(): Promise<void> }[] = [];
      const spawner: ProcessSpawner = {
        spawn(request) {
          signal.throwIfAborted();
          const directory = client.inputDirectory(); const job = randomUUID(); const name = 'redline-' + job;
          let cleanup: Promise<void> | undefined;
          const owned = { directory, reap: () => cleanup ??= client.remove(name, job).catch(() => {
            warning('Container cleanup could not be confirmed. Only owned expired containers will be reconciled.');
          }) };
          let started = false;
          jobs.push({ directory, reap: () => started ? owned.reap() : Promise.resolve() });
          const selected = input(harness, request, directory, state.workDirectory);
          const args = containerArguments(image, client.owner, job, Math.max(1, deadline - Date.now()), limits);
          args[0] = 'run';
          if (/[,\r\n]/u.test(directory)) throw new Error('Unsupported container input path');
          args.splice(args.length - 1, 0, '--mount', `type=bind,src=${directory},dst=${INPUT},readonly`,
            ...Object.keys(selected.env).flatMap(key => ['--env', key]));
          args.push(harness, ...selected.args); started = true;
          const child = client.spawn(args, request.stdin, selected.env, signal);
          return { stdout: child.stdout, stderr: child.stderr, wait: () => child.wait(), kill() { child.kill(); void owned.reap(); } };
        },
      };
      try { return await executor(harness, spawner).execute(state.inner, prompt, options); }
      finally {
        await Promise.all(jobs.map(async job => { await job.reap(); await rm(job.directory, { recursive: true, force: true }).catch(() => warning('Generated container input cleanup failed.')); }));
      }
    },
  };
}
