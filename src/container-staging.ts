import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import {
  createPreparedContainerLauncher,
  type ContainerEngine,
  type PreparedContainer,
  type ReviewBackendLauncher,
  type RunningReviewBackend,
} from './backend-process.js';
import { checkedDirectory } from './review-bundle.js';
import type {
  FirstRunnableReviewConfiguration,
  SelectedModelCredential,
} from './review-configuration.js';
import {
  MODEL_VISIBLE_REVIEW_DIRECTORY,
  MODEL_VISIBLE_SOURCE_DIRECTORY,
} from './review-prompt.js';

export const CONTAINER_REVIEW_DIRECTORY = MODEL_VISIBLE_REVIEW_DIRECTORY;
export const CONTAINER_SOURCE_DIRECTORY = MODEL_VISIBLE_SOURCE_DIRECTORY;
export const OPENCODE_COORDINATOR_SESSION_ID = 'redline-coordinator';

const MAX_BOOTSTRAP_ENVELOPE_BYTES = 2 * 1024 * 1024;
const CONTAINER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const OWNED_CONTAINER_ID_PATTERN = /^[a-f0-9]{12,64}$/u;
const OWNERSHIP_LABEL = 'io.redline.review-owner';
const IMAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9./:_-]*$/u;
const ENGINE_COMMAND_TIMEOUT_MS = 2 * 60 * 1_000;
const execFileAsync = promisify(execFile);

export interface ContainerEngineClient {
  execute(
    engine: ContainerEngine,
    arguments_: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<string>;
}

export interface ContainerStagingInput {
  engine: ContainerEngine;
  image: string;
  reviewDirectory: string;
  sourceDirectory: string;
  configuration: FirstRunnableReviewConfiguration;
  credential: SelectedModelCredential;
}

interface ContainerStagingDependencies {
  engineClient?: ContainerEngineClient;
  containerId?: () => string;
  preparedLauncher?: (container: PreparedContainer) => ReviewBackendLauncher;
}

interface BootstrapEnvelope {
  version: 1;
  backend: 'pi' | 'opencode';
  prompt: string;
  model: {
    provider: string;
    endpoint: string;
    model: string;
    credential: string;
  };
}

export class ExecFileContainerEngineClient implements ContainerEngineClient {
  async execute(
    engine: ContainerEngine,
    arguments_: readonly string[],
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const { stdout } = await execFileAsync(engine, [...arguments_], {
      timeout: ENGINE_COMMAND_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return stdout;
  }
}

function validateImage(image: string): void {
  const marker = '@sha256:';
  const markerIndex = image.indexOf(marker);
  if (markerIndex <= 0 || markerIndex !== image.lastIndexOf(marker)) {
    throw new Error('runner image must use one immutable sha256 digest');
  }
  const name = image.slice(0, markerIndex);
  const digest = image.slice(markerIndex + marker.length);
  if (!IMAGE_NAME_PATTERN.test(name) || !/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error('runner image must use an immutable sha256 digest');
  }
  const segments = name.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error('runner image name is invalid');
  }
  if ((segments.at(-1) as string).includes(':')) {
    throw new Error('runner image tags are unsupported');
  }
}

function validateInput(input: ContainerStagingInput): void {
  if (input.engine !== 'podman' && input.engine !== 'docker') {
    throw new Error('container engine is unsupported');
  }
  validateImage(input.image);
  if (input.credential.provider !== input.configuration.model.provider) {
    throw new Error('selected credential does not match the configured provider');
  }
}

function defaultContainerId(backend: 'pi' | 'opencode'): string {
  return `redline-${backend}-${randomUUID().replaceAll('-', '')}`;
}

function createArguments(containerId: string, ownershipMarker: string, image: string): string[] {
  return [
    'create',
    '--name',
    containerId,
    '--label',
    `${OWNERSHIP_LABEL}=${ownershipMarker}`,
    '--interactive',
    '--read-only',
    '--user',
    '10001:10001',
    '--workdir',
    CONTAINER_SOURCE_DIRECTORY,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '256',
    '--tmpfs',
    '/tmp/redline:rw,nosuid,nodev,noexec,size=64m,mode=1777',
    image,
  ];
}

function serializeBootstrapEnvelope(
  input: ContainerStagingInput,
  prompt: string,
): string {
  const envelope: BootstrapEnvelope = {
    version: 1,
    backend: input.configuration.backend,
    prompt,
    model: {
      provider: input.configuration.model.provider,
      endpoint: input.configuration.model.endpoint,
      model: input.configuration.model.model,
      credential: input.credential.value,
    },
  };
  const serialized = JSON.stringify(envelope);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_BOOTSTRAP_ENVELOPE_BYTES) {
    throw new Error('runner bootstrap envelope exceeds its byte limit');
  }
  return serialized;
}

function wrapRunningBackend(
  running: RunningReviewBackend,
  remove: () => Promise<void>,
): RunningReviewBackend {
  return {
    reporting: running.reporting,
    stdout: running.stdout,
    stderr: running.stderr,
    async wait() {
      try {
        return await running.wait();
      } finally {
        await remove();
      }
    },
    async stop() {
      try {
        await running.stop();
      } finally {
        await remove();
      }
    },
    async kill() {
      try {
        await running.kill();
      } finally {
        await remove();
      }
    },
  };
}

export function createContainerStagingLauncher(
  input: ContainerStagingInput,
  dependencies: ContainerStagingDependencies = {},
): ReviewBackendLauncher {
  validateInput(input);
  const engineClient = dependencies.engineClient ?? new ExecFileContainerEngineClient();
  const containerIdFactory = dependencies.containerId ?? (() => defaultContainerId(input.configuration.backend));
  const preparedLauncherFactory = dependencies.preparedLauncher ?? createPreparedContainerLauncher;
  let started = false;

  return {
    async start(launchInput) {
      if (started) throw new Error('container staging launcher can start only once');
      started = true;
      if (launchInput.backend !== input.configuration.backend) {
        throw new Error('staged container backend does not match the review backend');
      }
      if (launchInput.signal.aborted) throw new Error('container staging was cancelled');

      const bootstrapEnvelope = serializeBootstrapEnvelope(input, launchInput.prompt);
      const [reviewDirectory, sourceDirectory] = await Promise.all([
        checkedDirectory(input.reviewDirectory, 'review directory'),
        checkedDirectory(input.sourceDirectory, 'source directory'),
      ]);
      const containerId = containerIdFactory();
      if (!CONTAINER_ID_PATTERN.test(containerId)) throw new Error('generated container id is invalid');
      const ownershipMarker = randomUUID().replaceAll('-', '');

      let created = false;
      let removal: Promise<void> | undefined;
      const remove = (): Promise<void> => {
        if (!created) return Promise.resolve();
        removal ??= engineClient.execute(input.engine, ['rm', '--force', containerId]).then(() => undefined);
        return removal;
      };
      const reconcileAmbiguousCreate = async (): Promise<void> => {
        const output = await engineClient.execute(input.engine, [
          'ps',
          '--all',
          '--quiet',
          '--filter',
          `label=${OWNERSHIP_LABEL}=${ownershipMarker}`,
        ]);
        const ownedIds = output.split(/\r?\n/u).filter((value) => value.length > 0);
        if (ownedIds.length === 0) return;
        if (ownedIds.length !== 1 || !OWNED_CONTAINER_ID_PATTERN.test(ownedIds[0] as string)) {
          throw new Error('ambiguous container create reconciliation returned invalid ownership data');
        }
        await engineClient.execute(input.engine, ['rm', '--force', ownedIds[0] as string]);
      };

      try {
        try {
          await engineClient.execute(
            input.engine,
            createArguments(containerId, ownershipMarker, input.image),
            { signal: launchInput.signal },
          );
          created = true;
        } catch (createError) {
          try {
            await reconcileAmbiguousCreate();
          } catch (cleanupError) {
            throw new AggregateError(
              [createError, cleanupError],
              'container creation failed and ownership reconciliation was inconclusive',
            );
          }
          throw createError;
        }
        await engineClient.execute(
          input.engine,
          ['cp', `${reviewDirectory}/.`, `${containerId}:${CONTAINER_REVIEW_DIRECTORY}`],
          { signal: launchInput.signal },
        );
        await engineClient.execute(
          input.engine,
          ['cp', `${sourceDirectory}/.`, `${containerId}:${CONTAINER_SOURCE_DIRECTORY}`],
          { signal: launchInput.signal },
        );

        const container: PreparedContainer = {
          engine: input.engine,
          id: containerId,
          backend: input.configuration.backend,
          ...(input.configuration.backend === 'opencode'
            ? { opencodeSessionId: OPENCODE_COORDINATOR_SESSION_ID }
            : {}),
        };
        const running = await preparedLauncherFactory(container).start({
          ...launchInput,
          prompt: bootstrapEnvelope,
        });
        return wrapRunningBackend(running, remove);
      } catch (error) {
        if (created) {
          try {
            await remove();
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'container staging and cleanup failed');
          }
        }
        throw error;
      }
    },
  };
}
