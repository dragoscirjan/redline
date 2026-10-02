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
const CONTAINER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const OWNED_CONTAINER_ID_PATTERN = /^[a-f0-9]{12,64}$/u;
const OWNED_VOLUME_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,127}$/u;
const OWNERSHIP_LABEL = 'io.redline.review-owner';
const IMAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9./:_-]*$/u;
const ENGINE_COMMAND_TIMEOUT_MS = 2 * 60 * 1_000;
const execFileAsync = promisify(execFile);

type OwnedResourceKind = 'container' | 'volume';

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

export function validateDigestPinnedImage(image: string): void {
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
  validateDigestPinnedImage(input.image);
  if (input.credential.provider !== input.configuration.model.provider) {
    throw new Error('selected credential does not match the configured provider');
  }
}

function marker(): string {
  return randomUUID().replaceAll('-', '');
}

function defaultContainerId(backend: 'pi' | 'opencode'): string {
  return `redline-${backend}-${marker()}`;
}

function volumeCreateArguments(name: string, ownershipMarker: string): string[] {
  return [
    'volume',
    'create',
    '--label',
    `${OWNERSHIP_LABEL}=${ownershipMarker}`,
    name,
  ];
}

function stagingCreateArguments(
  containerId: string,
  ownershipMarker: string,
  reviewVolume: string,
  sourceVolume: string,
  image: string,
): string[] {
  return [
    'create',
    '--name',
    containerId,
    '--label',
    `${OWNERSHIP_LABEL}=${ownershipMarker}`,
    '--read-only',
    '--network',
    'none',
    '--user',
    '10001:10001',
    '--workdir',
    CONTAINER_SOURCE_DIRECTORY,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '64',
    '--mount',
    `type=volume,src=${reviewVolume},dst=${CONTAINER_REVIEW_DIRECTORY}`,
    '--mount',
    `type=volume,src=${sourceVolume},dst=${CONTAINER_SOURCE_DIRECTORY}`,
    image,
  ];
}

function runtimeCreateArguments(
  containerId: string,
  ownershipMarker: string,
  reviewVolume: string,
  sourceVolume: string,
  image: string,
): string[] {
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
    '--mount',
    `type=volume,src=${reviewVolume},dst=${CONTAINER_REVIEW_DIRECTORY},readonly`,
    '--mount',
    `type=volume,src=${sourceVolume},dst=${CONTAINER_SOURCE_DIRECTORY},readonly`,
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

function listArguments(kind: OwnedResourceKind, ownershipMarker: string): string[] {
  const filter = `label=${OWNERSHIP_LABEL}=${ownershipMarker}`;
  return kind === 'container'
    ? ['ps', '--all', '--quiet', '--filter', filter]
    : ['volume', 'ls', '--quiet', '--filter', filter];
}

function removeArguments(kind: OwnedResourceKind, id: string): string[] {
  return kind === 'container'
    ? ['rm', '--force', id]
    : ['volume', 'rm', '--force', id];
}

function parseOwnedResources(kind: OwnedResourceKind, output: string): string[] {
  const pattern = kind === 'container' ? OWNED_CONTAINER_ID_PATTERN : OWNED_VOLUME_NAME_PATTERN;
  const values = output.split(/\r?\n/u).filter((value) => value.length > 0);
  if (values.some((value) => !pattern.test(value))) {
    throw new Error(`owned ${kind} lookup returned invalid data`);
  }
  return values;
}

async function listOwnedResources(
  client: ContainerEngineClient,
  engine: ContainerEngine,
  kind: OwnedResourceKind,
  ownershipMarker: string,
): Promise<string[]> {
  return parseOwnedResources(
    kind,
    await client.execute(engine, listArguments(kind, ownershipMarker)),
  );
}

async function reconcileFailedCreate(
  client: ContainerEngineClient,
  engine: ContainerEngine,
  kind: OwnedResourceKind,
  ownershipMarker: string,
): Promise<void> {
  const owned = await listOwnedResources(client, engine, kind, ownershipMarker);
  if (owned.length === 0) return;
  if (owned.length !== 1) {
    throw new Error(`ambiguous ${kind} create reconciliation returned multiple owned resources`);
  }
  await client.execute(engine, removeArguments(kind, owned[0] as string));
}

async function createOwnedContainer(
  client: ContainerEngineClient,
  engine: ContainerEngine,
  arguments_: readonly string[],
  ownershipMarker: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    await client.execute(engine, arguments_, { signal });
  } catch (createError) {
    try {
      await reconcileFailedCreate(client, engine, 'container', ownershipMarker);
    } catch (cleanupError) {
      throw new AggregateError(
        [createError, cleanupError],
        'container creation failed and ownership reconciliation was inconclusive',
      );
    }
    throw createError;
  }
}

async function createOwnedVolume(
  client: ContainerEngineClient,
  engine: ContainerEngine,
  name: string,
  ownershipMarker: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    await client.execute(engine, volumeCreateArguments(name, ownershipMarker), { signal });
    const owned = await listOwnedResources(client, engine, 'volume', ownershipMarker);
    if (owned.length !== 1 || owned[0] !== name) {
      throw new Error('created volume ownership could not be verified');
    }
  } catch (createError) {
    try {
      await reconcileFailedCreate(client, engine, 'volume', ownershipMarker);
    } catch (cleanupError) {
      throw new AggregateError(
        [createError, cleanupError],
        'volume creation failed and ownership reconciliation was inconclusive',
      );
    }
    throw createError;
  }
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
      const runtimeContainerId = containerIdFactory();
      if (!CONTAINER_NAME_PATTERN.test(runtimeContainerId)) {
        throw new Error('generated container id is invalid');
      }

      const runtimeMarker = marker();
      const stagingMarker = marker();
      const reviewVolumeMarker = marker();
      const sourceVolumeMarker = marker();
      const stagingContainerId = `redline-stage-${stagingMarker}`;
      const reviewVolume = `redline-review-${reviewVolumeMarker}`;
      const sourceVolume = `redline-source-${sourceVolumeMarker}`;

      let runtimeCreated = false;
      let stagingCreated = false;
      let reviewVolumeCreated = false;
      let sourceVolumeCreated = false;
      let removal: Promise<void> | undefined;

      const removeResources = async (): Promise<void> => {
        const errors: unknown[] = [];
        const remove = async (
          kind: OwnedResourceKind,
          id: string,
          isCreated: () => boolean,
          markRemoved: () => void,
        ): Promise<void> => {
          if (!isCreated()) return;
          try {
            await engineClient.execute(input.engine, removeArguments(kind, id));
            markRemoved();
          } catch (error) {
            errors.push(error);
          }
        };

        await remove('container', runtimeContainerId, () => runtimeCreated, () => { runtimeCreated = false; });
        await remove('container', stagingContainerId, () => stagingCreated, () => { stagingCreated = false; });
        await remove('volume', reviewVolume, () => reviewVolumeCreated, () => { reviewVolumeCreated = false; });
        await remove('volume', sourceVolume, () => sourceVolumeCreated, () => { sourceVolumeCreated = false; });
        if (errors.length > 0) throw new AggregateError(errors, 'container staging cleanup failed');
      };
      const remove = (): Promise<void> => {
        removal ??= removeResources();
        return removal;
      };

      try {
        await createOwnedVolume(
          engineClient,
          input.engine,
          reviewVolume,
          reviewVolumeMarker,
          launchInput.signal,
        );
        reviewVolumeCreated = true;
        await createOwnedVolume(
          engineClient,
          input.engine,
          sourceVolume,
          sourceVolumeMarker,
          launchInput.signal,
        );
        sourceVolumeCreated = true;
        await createOwnedContainer(
          engineClient,
          input.engine,
          stagingCreateArguments(
            stagingContainerId,
            stagingMarker,
            reviewVolume,
            sourceVolume,
            input.image,
          ),
          stagingMarker,
          launchInput.signal,
        );
        stagingCreated = true;
        await engineClient.execute(
          input.engine,
          ['cp', `${reviewDirectory}/.`, `${stagingContainerId}:${CONTAINER_REVIEW_DIRECTORY}`],
          { signal: launchInput.signal },
        );
        await engineClient.execute(
          input.engine,
          ['cp', `${sourceDirectory}/.`, `${stagingContainerId}:${CONTAINER_SOURCE_DIRECTORY}`],
          { signal: launchInput.signal },
        );
        await engineClient.execute(input.engine, removeArguments('container', stagingContainerId));
        stagingCreated = false;

        await createOwnedContainer(
          engineClient,
          input.engine,
          runtimeCreateArguments(
            runtimeContainerId,
            runtimeMarker,
            reviewVolume,
            sourceVolume,
            input.image,
          ),
          runtimeMarker,
          launchInput.signal,
        );
        runtimeCreated = true;

        const container: PreparedContainer = {
          engine: input.engine,
          id: runtimeContainerId,
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
        try {
          await remove();
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'container staging and cleanup failed');
        }
        throw error;
      }
    },
  };
}
