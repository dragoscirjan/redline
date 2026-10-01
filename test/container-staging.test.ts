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
  private readonly volumesByLabel = new Map<string, string>();

  async execute(
    engine: 'podman' | 'docker',
    arguments_: readonly string[],
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const index = this.calls.length;
    this.calls.push({ engine, arguments: [...arguments_], aborted: options.signal?.aborted ?? false });
    if (index === this.failAt) throw new Error('fake engine failure');
    if (arguments_[0] === 'volume' && arguments_[1] === 'create') {
      this.volumesByLabel.set(arguments_[3] as string, arguments_.at(-1) as string);
    }
    if (arguments_[0] === 'volume' && arguments_[1] === 'ls') {
      const key = (arguments_.at(-1) as string).replace(/^label=/u, '');
      return `${this.volumesByLabel.get(key) ?? ''}\n`;
    }
    if (arguments_[0] === 'volume' && arguments_[1] === 'rm') {
      for (const [label, name] of this.volumesByLabel) {
        if (name === arguments_.at(-1)) this.volumesByLabel.delete(label);
      }
    }
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

test('creates, copies, starts, and removes locked-down resources for both engines', async () => {
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
      assert.equal(capture.container?.id, `redline-${scenario.backend}-test`);
      assert.equal(capture.container?.backend, scenario.backend);
      assert.equal(
        capture.container?.opencodeSessionId,
        scenario.backend === 'opencode' ? OPENCODE_COORDINATOR_SESSION_ID : undefined,
      );

      const heads = engineClient.calls.map((call) => call.arguments[0]);
      assert.deepEqual(heads, [
        'volume', 'volume', 'volume', 'volume',
        'create', 'cp', 'cp', 'rm',
        'create',
      ]);

      const [reviewVolumeCreate, sourceVolumeCreate] = [engineClient.calls[0], engineClient.calls[2]];
      for (const call of [reviewVolumeCreate, sourceVolumeCreate]) {
        assert.deepEqual(call?.arguments.slice(0, 3), ['volume', 'create', '--label']);
        assert.match(call?.arguments[3] as string, /^io\.redline\.review-owner=[a-f0-9]{32}$/u);
        assert.match(call?.arguments.at(-1) as string, /^redline-(review|source)-[a-f0-9]{32}$/u);
      }
      for (const index of [1, 3]) {
        assert.deepEqual(engineClient.calls[index]?.arguments.slice(0, 3), ['volume', 'ls', '--quiet']);
        assert.match(
          engineClient.calls[index]?.arguments.at(-1) as string,
          /^label=io\.redline\.review-owner=[a-f0-9]{32}$/u,
        );
      }

      const stagingName = engineClient.calls[4]?.arguments[engineClient.calls[4]!.arguments.indexOf('--name') + 1] as string;
      const stagingCreate = engineClient.calls[4]?.arguments ?? [];
      assert.equal(stagingCreate[0], 'create');
      assert.match(stagingName, /^redline-stage-[a-f0-9]{32}$/u);
      assert.ok(stagingCreate.includes('--read-only'));
      assert.deepEqual(stagingCreate.slice(stagingCreate.indexOf('--network'), stagingCreate.indexOf('--network') + 2), ['--network', 'none']);
      assert.ok(stagingCreate.includes('10001:10001'));
      assert.ok(stagingCreate.includes('ALL'));
      assert.ok(stagingCreate.includes('no-new-privileges'));
      assert.ok(!stagingCreate.includes('--tmpfs'));
      assert.equal(stagingCreate.filter((value) => value === '--mount').length, 2);
      assert.ok(
        stagingCreate.some((value) => /^type=volume,src=redline-review-.+,dst=\/workspace\/review$/.test(value)),
      );
      assert.ok(
        stagingCreate.some((value) => /^type=volume,src=redline-source-.+,dst=\/workspace\/source$/.test(value)),
      );
      assert.equal(stagingCreate.at(-1), IMAGE);
      assert.ok(!stagingCreate.some((value) => ['--volume', '-v', '--privileged'].includes(value)));

      assert.deepEqual(engineClient.calls[5]?.arguments, [
        'cp',
        `${await realpath(review)}/.`,
        `${stagingName}:${CONTAINER_REVIEW_DIRECTORY}`,
      ]);
      assert.deepEqual(engineClient.calls[6]?.arguments, [
        'cp',
        `${await realpath(source)}/.`,
        `${stagingName}:${CONTAINER_SOURCE_DIRECTORY}`,
      ]);
      assert.deepEqual(engineClient.calls[7]?.arguments, ['rm', '--force', stagingName]);

      const runtimeCreate = engineClient.calls[8]?.arguments ?? [];
      assert.equal(runtimeCreate[0], 'create');
      assert.ok(runtimeCreate.includes('--interactive'));
      assert.ok(runtimeCreate.includes('--read-only'));
      assert.equal(runtimeCreate[runtimeCreate.indexOf('--name') + 1], `redline-${scenario.backend}-test`);
      assert.equal(runtimeCreate.at(-1), IMAGE);
      assert.equal(runtimeCreate.filter((value) => value === '--mount').length, 2);
      assert.ok(
        runtimeCreate.some((value) => /^type=volume,src=redline-review-.+,dst=\/workspace\/review,readonly$/.test(value)),
      );
      assert.ok(
        runtimeCreate.some((value) => /^type=volume,src=redline-source-.+,dst=\/workspace\/source,readonly$/.test(value)),
      );
      const tmpfsIndex = runtimeCreate.indexOf('--tmpfs');
      assert.equal(runtimeCreate[tmpfsIndex + 1], '/tmp/redline:rw,nosuid,nodev,noexec,size=64m,mode=1777');

      const envelope = JSON.parse(capture.envelope as string) as Record<string, unknown>;
      assert.equal(envelope.backend, scenario.backend);
      assert.equal(envelope.prompt, 'trusted prompt');
      assert.match(capture.envelope as string, /selected-secret/u);
      assert.doesNotMatch(capture.envelope as string, /unused-secret|GH_TOKEN/u);
      assert.doesNotMatch(JSON.stringify(engineClient.calls), /selected-secret|unused-secret|GH_TOKEN/u);

      assert.deepEqual(await running.wait(), { code: 0, signal: null });
      const cleanup = engineClient.calls.slice(9);
      assert.deepEqual(
        cleanup.map((call) => call.arguments[0]),
        ['rm', 'volume', 'volume'],
      );
      assert.deepEqual(cleanup[0]?.arguments, ['rm', '--force', `redline-${scenario.backend}-test`]);
      assert.equal(cleanup.filter((call) => call.arguments[0] === 'volume' && call.arguments[1] === 'rm').length, 2);
    });
  }
});

test('removes owned resources after copy or backend-launch failure', async () => {
  await withDirectories(async ({ review, source }) => {
    for (const scenario of [
      { failure: 'copy' as const, failAt: 5, cleanupStart: 6 },
      { failure: 'launch' as const, failAt: undefined, cleanupStart: 9 },
    ]) {
      const engineClient = new FakeEngineClient();
      if (scenario.failAt !== undefined) engineClient.failAt = scenario.failAt;
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
          containerId: () => `redline-failure-${scenario.failure}`,
          preparedLauncher: scenario.failure === 'launch'
            ? () => ({ start: async () => Promise.reject(new Error('launch failed')) })
            : preparedFactory(capture),
        },
      );
      await assert.rejects(
        launcher.start({ backend: 'pi', prompt: 'prompt', signal: new AbortController().signal }),
      );
      assert.equal(capture.starts, 0);
      const cleanup = engineClient.calls.slice(scenario.cleanupStart);
      const removals = cleanup.filter((call) => call.arguments[0] === 'rm' && call.arguments[1] === '--force').map((call) => call.arguments.at(-1) as string);
      if (scenario.failure === 'copy') {
        assert.equal(removals.length, 1);
        assert.match(removals[0] as string, /^redline-stage-[a-f0-9]{32}$/u);
      } else {
        assert.deepEqual(removals, [`redline-failure-${scenario.failure}`]);
      }
      assert.equal(cleanup.filter((call) => call.arguments[0] === 'volume' && call.arguments[1] === 'rm').length, 2);
    }
  });
});

test('never removes resources when volume creation did not succeed', async () => {
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
    assert.deepEqual(
      engineClient.calls.map((call) => `${call.arguments[0]} ${call.arguments[1] ?? ''}`.trim()),
      ['volume create', 'volume ls'],
    );
    assert.equal(engineClient.calls.some((call) => call.arguments[0] === 'rm'), false);
  });
});

test('reconciles a marker-matched volume after ambiguous volume creation', async () => {
  await withDirectories(async ({ review, source }) => {
    const ownedVolume = 'redline-review-abc123';
    const calls: string[][] = [];
    let ownershipLabel = '';
    const engineClient: ContainerEngineClient = {
      async execute(_engine, arguments_) {
        const argumentsCopy = [...arguments_];
        calls.push(argumentsCopy);
        if (argumentsCopy[0] === 'volume' && argumentsCopy[1] === 'create') {
          ownershipLabel = argumentsCopy[argumentsCopy.indexOf('--label') + 1] as string;
          throw new Error('volume creation was interrupted after the engine created the volume');
        }
        if (argumentsCopy[0] === 'volume' && argumentsCopy[1] === 'ls') {
          assert.equal(argumentsCopy.at(-1), `label=${ownershipLabel}`);
          return `${ownedVolume}\n`;
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
      { engineClient, containerId: () => 'redline-ambiguous-volume-test' },
    );

    await assert.rejects(
      launcher.start({ backend: 'pi', prompt: 'prompt', signal: new AbortController().signal }),
      /interrupted/u,
    );
    assert.deepEqual(
      calls.map((arguments_) => `${arguments_[0]} ${arguments_[1] ?? ''}`.trim()),
      ['volume create', 'volume ls', 'volume rm'],
    );
    assert.deepEqual(calls[2], ['volume', 'rm', '--force', ownedVolume]);
  });
});

test('reconciles and removes a marker-matched container after ambiguous create failure', async () => {
  await withDirectories(async ({ review, source }) => {
    const ownedId = 'b'.repeat(64);
    const calls: string[][] = [];
    let ownershipLabel = '';
    let lastCreatedVolume = '';
    const engineClient: ContainerEngineClient = {
      async execute(_engine, arguments_) {
        const argumentsCopy = [...arguments_];
        calls.push(argumentsCopy);
        if (argumentsCopy[0] === 'volume' && argumentsCopy[1] === 'create') {
          lastCreatedVolume = argumentsCopy.at(-1) as string;
          return '';
        }
        if (argumentsCopy[0] === 'volume' && argumentsCopy[1] === 'ls') {
          return `${lastCreatedVolume}\n`;
        }
        if (argumentsCopy[0] === 'volume' && argumentsCopy[1] === 'rm') {
          return '';
        }
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
    assert.deepEqual(
      calls.map((arguments_) => arguments_[0]),
      ['volume', 'volume', 'volume', 'volume', 'create', 'ps', 'rm', 'volume', 'volume'],
    );
    assert.deepEqual(calls[6], ['rm', '--force', ownedId]);
  });
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
      const cleanup = engineClient.calls.slice(9);
      assert.deepEqual(
        cleanup.map((call) => call.arguments[0]),
        ['rm', 'volume', 'volume'],
      );
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
