import { CapabilityError } from '../application/capabilities.ts';
import { createDockerExecutor } from '../harness-executor/docker-executor.ts';
import { DockerClient, type ContainerLimits } from '../harness-worker/docker-client.ts';
import { loadWorkerImage } from '../harness-worker/images.ts';
import type { HarnessExecutor, HarnessName } from '../harness-executor/types.ts';
import { executable } from './process.ts';

export interface IsolationOptions {
  readonly mode: 'direct' | 'docker';
  readonly manifest: string | undefined;
  readonly limits: ContainerLimits;
}
export interface IsolatedRuntime {
  readonly executor: HarnessExecutor;
  readonly identity: string;
  close(): Promise<void>;
}
export async function isolatedRuntime(harness: HarnessName, options: IsolationOptions, repository: string, state: string,
  env: NodeJS.ProcessEnv, signal: AbortSignal, warning: (message: string) => void): Promise<IsolatedRuntime> {
  let client: DockerClient | undefined;
  try {
    if (harness === 'echo' || process.platform !== 'linux') throw new CapabilityError('Docker isolation initially supports Pi/OpenCode on Linux only');
    const command = await executable('docker', env.PATH ?? '', repository);
    const image = await loadWorkerImage(harness, repository, options.manifest);
    client = await DockerClient.create(command, repository, state, env);
    await client.preflight(image, signal);
    const owned = client;
    return { executor: createDockerExecutor(harness, client, image, options.limits, signal, warning),
      identity: 'docker:' + image.reference, close: () => owned.close() };
  } catch {
    await client?.close();
    if (signal.aborted) signal.throwIfAborted();
    throw new CapabilityError('Requested Docker isolation is unavailable; check the Linux engine, image manifest and required security profile. No direct fallback was attempted.');
  }
}
