import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type {
  BackendExit,
  PreparedContainer,
  ReviewBackendLauncher,
  RunningReviewBackend,
} from '../src/backend-process.js';
import {
  CONTAINER_REVIEW_DIRECTORY,
  CONTAINER_SOURCE_DIRECTORY,
  OPENCODE_COORDINATOR_SESSION_ID,
  createContainerStagingLauncher,
  type ContainerEngineClient,
} from '../src/container-staging.js';
import {
  parseFirstRunnableReviewConfiguration,
  selectDirectModelCredential,
} from '../src/review-configuration.js';

const IMAGE_DIGEST = 'a'.repeat(64);
const IMAGE = `ghcr.io/dragoscirjan/redline-runner@sha256:${IMAGE_DIGEST}`;

class FakeEngineClient implements ContainerEngineClient {
  readonly calls: Array<{ engine: string; arguments: string[]; aborted: boolean }> = [];
  failAt: number | undefined;

  async execute(
    engine: 'podman' | 'docker',
    arguments_: readonly string[],
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const index = this.calls.length;
    this.calls.push({ engine, arguments: [...arguments_], aborted: options.signal?.aborted ?? false });
    if (index === this.failAt) throw new Error('fake engine failure');
    return '';
  }
}

class FakeRunningBackend implements RunningReviewBackend {
  readonly stdout = (async function* empty() {})();
  readonly stderr = (async function* empty() {})();
  stopCalls = 0;
  killCalls = 0;

  constructor(readonly reporting: RunningReviewBackend['reporting']) {}

  async wait(): Promise<BackendExit> {
    return { code: 0, signal: null };
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  async kill(): Promise<void> {
    this.killCalls += 1;
  }
}

async function withDirectories<T>(
  run: (fixture: { review: string; source: string }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'redline-stage-'));
  const review = join(root, 'review');
  const source = join(root, 'source');
  await mkdir(review);
  await mkdir(source);
  try {
    return await run({ review, source });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function configuration(backend: 'pi' | 'opencode') {
  return parseFirstRunnableReviewConfiguration({
    backend,
    modelConfig: JSON.stringify({
      provider: 'private-provider',
      endpoint: 'https://models.example.test/v1',
      model: 'review/model',
    }),
    credentialIsolation: 'direct',
  });
}

function preparedFactory(
  capture: { container?: PreparedContainer; envelope?: string; starts: number },
): (container: PreparedContainer) => ReviewBackendLauncher {
  return (container) => {
    capture.container = container;
    return {
      async start(input) {
        capture.starts += 1;
        capture.envelope = input.prompt;
        return new FakeRunningBackend(
          container.backend === 'pi'
            ? { backend: 'pi' }
            : { backend: 'opencode', sessionId: container.opencodeSessionId as string },
        );
      },
    };
  };
}

test('creates, copies, starts, and removes a locked-down container for both engines', async () => {
  for (const scenario of [
    { engine: 'podman' as const, backend: 'pi' as const },
    { engine: 'docker' as const, backend: 'opencode' as const },
  ]) {
    await withDirectories(async ({ review, source }) => {
      const engineClient = new FakeEngineClient();
      const capture = { starts: 0 } as { container?: PreparedContainer; envelope?: string; starts: number };
      const selected = selectDirectModelCredential(
        configuration(scenario.backend),
        JSON.stringify({ 'private-provider': 'selected-secret', unused: 'unused-secret' }),
      );
      const launcher = createContainerStagingLauncher(
        {
          engine: scenario.engine,
          image: IMAGE,
          reviewDirectory: review,
          sourceDirectory: source,
          configuration: configuration(scenario.backend),
          credential: selected,
        },
        {
          engineClient,
          containerId: () => `redline-${scenario.backend}-test`,
          preparedLauncher: preparedFactory(capture),
        },
      );
      const running = await launcher.start({
        backend: scenario.backend,
        prompt: 'trusted prompt',
        signal: new AbortController().signal,
      });

      assert.equal(capture.starts, 1);
      assert.equal(capture.container?.engine, scenario.engine);
      assert.equal(capture.container?.backend, scenario.backend);
      assert.equal(
        capture.container?.opencodeSessionId,
        scenario.backend === 'opencode' ? OPENCODE_COORDINATOR_SESSION_ID : undefined,
      );
      assert.equal(engineClient.calls.length, 3);
      const create = engineClient.calls[0]?.arguments ?? [];
      assert.equal(create[0], 'create');
      assert.ok(create.includes('--interactive'));
      assert.ok(create.includes('--read-only'));
      const labelIndex = create.indexOf('--label');
      assert.match(create[labelIndex + 1] as string, /^io\.redline\.review-owner=[a-f0-9]{32}$/u);
      assert.ok(create.includes('10001:10001'));
      assert.ok(create.includes('ALL'));
      assert.ok(create.includes('no-new-privileges'));
      assert.ok(create.includes('/tmp/redline:rw,nosuid,nodev,noexec,size=64m,mode=1777'));
      assert.equal(create.at(-1), IMAGE);
      assert.ok(!create.some((value) => ['--mount', '--volume', '-v', '--privileged'].includes(value)));

      const canonicalReview = await realpath(review);
      const canonicalSource = await realpath(source);
      assert.deepEqual(engineClient.calls[1]?.arguments, [
        'cp',
        `${canonicalReview}/.`,
        `redline-${scenario.backend}-test:${CONTAINER_REVIEW_DIRECTORY}`,
      ]);
      assert.deepEqual(engineClient.calls[2]?.arguments, [
        'cp',
        `${canonicalSource}/.`,
        `redline-${scenario.backend}-test:${CONTAINER_SOURCE_DIRECTORY}`,
      ]);

      const envelope = JSON.parse(capture.envelope as string) as Record<string, unknown>;
      assert.equal(envelope.backend, scenario.backend);
      assert.equal(envelope.prompt, 'trusted prompt');
      assert.match(capture.envelope as string, /selected-secret/u);
      assert.doesNotMatch(capture.envelope as string, /unused-secret|GH_TOKEN/u);
      assert.doesNotMatch(JSON.stringify(engineClient.calls), /selected-secret|unused-secret|GH_TOKEN/u);

      assert.deepEqual(await running.wait(), { code: 0, signal: null });
      assert.deepEqual(engineClient.calls[3]?.arguments, [
        'rm',
        '--force',
        `redline-${scenario.backend}-test`,
      ]);
    });
  }
});

test('removes an owned container once after stop or kill', async () => {
  await withDirectories(async ({ review, source }) => {
    for (const action of ['stop', 'kill'] as const) {
      const engineClient = new FakeEngineClient();
      const config = configuration('pi');
      const credential = selectDirectModelCredential(config, JSON.stringify({ 'private-provider': 'secret' }));
      const backend = new FakeRunningBackend({ backend: 'pi' });
      const launcher = createContainerStagingLauncher(
        {
          engine: 'podman',
          image: IMAGE,
          reviewDirectory: review,
          sourceDirectory: source,
          configuration: config,
          credential,
        },
        {
          engineClient,
          containerId: () => `redline-${action}-test`,
          preparedLauncher: () => ({ start: async () => backend }),
        },
      );
      const running = await launcher.start({
        backend: 'pi',
        prompt: 'prompt',
        signal: new AbortController().signal,
      });

      await running[action]();
      await running.wait();

      assert.equal(backend.stopCalls, action === 'stop' ? 1 : 0);
      assert.equal(backend.killCalls, action === 'kill' ? 1 : 0);
      assert.equal(engineClient.calls.length, 4);
      assert.deepEqual(engineClient.calls.at(-1)?.arguments, [
        'rm',
        '--force',
        `redline-${action}-test`,
      ]);
    }
  });
});

test('does not remove a container when failed create has no ownership match', async () => {
  await withDirectories(async ({ review, source }) => {
    const engineClient = new FakeEngineClient();
    engineClient.failAt = 0;
    const config = configuration('pi');
    const credential = selectDirectModelCredential(config, JSON.stringify({ 'private-provider': 'secret' }));
    const launcher = createContainerStagingLauncher(
      {
        engine: 'podman',
        image: IMAGE,
        reviewDirectory: review,
        sourceDirectory: source,
        configuration: config,
        credential,
      },
      { engineClient, containerId: () => 'redline-create-failure-test' },
    );

    await assert.rejects(
      launcher.start({ backend: 'pi', prompt: 'prompt', signal: new AbortController().signal }),
    );
    assert.equal(engineClient.calls.length, 2);
    assert.equal(engineClient.calls[0]?.arguments[0], 'create');
    assert.deepEqual(engineClient.calls[1]?.arguments.slice(0, 4), ['ps', '--all', '--quiet', '--filter']);
    assert.equal(engineClient.calls.some((call) => call.arguments[0] === 'rm'), false);
  });
});

test('reconciles and removes a marker-matched container after ambiguous create failure', async () => {
  await withDirectories(async ({ review, source }) => {
    const ownedId = 'b'.repeat(64);
    const calls: string[][] = [];
    let ownershipLabel = '';
    const engineClient: ContainerEngineClient = {
      async execute(_engine, arguments_) {
        const argumentsCopy = [...arguments_];
        calls.push(argumentsCopy);
        if (argumentsCopy[0] === 'create') {
          ownershipLabel = argumentsCopy[argumentsCopy.indexOf('--label') + 1] as string;
          throw new Error('create result was interrupted after the daemon created the container');
        }
        if (argumentsCopy[0] === 'ps') {
          assert.equal(argumentsCopy.at(-1), `label=${ownershipLabel}`);
          return `${ownedId}\n`;
        }
        return '';
      },
    };
    const config = configuration('pi');
    const credential = selectDirectModelCredential(config, JSON.stringify({ 'private-provider': 'secret' }));
    const launcher = createContainerStagingLauncher(
      {
        engine: 'podman',
        image: IMAGE,
        reviewDirectory: review,
        sourceDirectory: source,
        configuration: config,
        credential,
      },
      { engineClient, containerId: () => 'redline-ambiguous-create-test' },
    );

    await assert.rejects(
      launcher.start({ backend: 'pi', prompt: 'prompt', signal: new AbortController().signal }),
      /interrupted/u,
    );
    assert.deepEqual(calls.map((arguments_) => arguments_[0]), ['create', 'ps', 'rm']);
    assert.deepEqual(calls[2], ['rm', '--force', ownedId]);
  });
});

test('removes an owned container after copy or backend-launch failure', async () => {
  await withDirectories(async ({ review, source }) => {
    for (const failure of ['copy', 'launch'] as const) {
      const engineClient = new FakeEngineClient();
      if (failure === 'copy') engineClient.failAt = 1;
      const capture = { starts: 0 } as { container?: PreparedContainer; envelope?: string; starts: number };
      const config = configuration('pi');
      const credential = selectDirectModelCredential(config, JSON.stringify({ 'private-provider': 'secret' }));
      const launcher = createContainerStagingLauncher(
        {
          engine: 'podman',
          image: IMAGE,
          reviewDirectory: review,
          sourceDirectory: source,
          configuration: config,
          credential,
        },
        {
          engineClient,
          containerId: () => `redline-failure-${failure}`,
          preparedLauncher: failure === 'launch'
            ? () => ({ start: async () => Promise.reject(new Error('launch failed')) })
            : preparedFactory(capture),
        },
      );
      await assert.rejects(
        launcher.start({ backend: 'pi', prompt: 'prompt', signal: new AbortController().signal }),
      );
      assert.deepEqual(engineClient.calls.at(-1)?.arguments, [
        'rm',
        '--force',
        `redline-failure-${failure}`,
      ]);
      assert.equal(capture.starts, 0);
    }
  });
});

test('fails before engine execution for mutable images, backend mismatches, and cancellation', async () => {
  await withDirectories(async ({ review, source }) => {
    const config = configuration('pi');
    const credential = selectDirectModelCredential(config, JSON.stringify({ 'private-provider': 'secret' }));
    assert.throws(
      () => createContainerStagingLauncher({
        engine: 'podman',
        image: 'ghcr.io/dragoscirjan/redline-runner:latest',
        reviewDirectory: review,
        sourceDirectory: source,
        configuration: config,
        credential,
      }),
      /immutable sha256 digest/u,
    );

    const engineClient = new FakeEngineClient();
    const launcher = createContainerStagingLauncher(
      {
        engine: 'podman',
        image: IMAGE,
        reviewDirectory: review,
        sourceDirectory: source,
        configuration: config,
        credential,
      },
      { engineClient },
    );
    await assert.rejects(
      launcher.start({ backend: 'opencode', prompt: 'prompt', signal: new AbortController().signal }),
      /does not match/u,
    );
    assert.equal(engineClient.calls.length, 0);

    const cancelledEngine = new FakeEngineClient();
    const cancelledLauncher = createContainerStagingLauncher(
      {
        engine: 'podman',
        image: IMAGE,
        reviewDirectory: review,
        sourceDirectory: source,
        configuration: config,
        credential,
      },
      { engineClient: cancelledEngine },
    );
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      cancelledLauncher.start({ backend: 'pi', prompt: 'prompt', signal: abort.signal }),
      /cancelled/u,
    );
    assert.equal(cancelledEngine.calls.length, 0);
  });
});
