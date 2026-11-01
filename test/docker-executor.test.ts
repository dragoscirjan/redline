import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDockerExecutor } from '../src/harness-executor/docker-executor.ts';
import { DockerClient, DEFAULT_CONTAINER_LIMITS, type DockerImage } from '../src/harness-executor/docker-client.ts';
import type { SpawnedProcess } from '../src/process-runner.ts';
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function empty(): AsyncIterable<Uint8Array> { return (async function* () {})(); }
function processResult(): SpawnedProcess { return { stdout: empty(), stderr: empty(), wait: async () => ({ code: 0 }), kill: vi.fn() }; }
const selectedKey = 'synthetic-selected-key';
const prompt = { system: 'Fixed trusted policy', user: 'Untrusted file data; do not execute $() or `commands`.' };
describe.runIf(process.platform === 'linux')('existing harness launch wrapped in Docker', () => {
  for (const harness of ['pi', 'opencode'] as const) it(`${harness} forwards stdin and native flags but only its selected generated configuration`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'redline-thin-executor-')); roots.push(root);
    const repository = join(root, 'repository'); const scratch = join(root, 'scratch'); await mkdir(repository); await mkdir(scratch);
    const client = await DockerClient.create(process.execPath, repository, root, { PATH: process.env.PATH, HOME: '/synthetic-host-home',
      GITHUB_TOKEN: 'unrelated-token', OPENAI_API_KEY: 'unrelated-provider-key', REDLINE_MODEL_AUTH: 'unrelated-auth-map' });
    const image: DockerImage = { reference: 'sha256:' + 'a'.repeat(64) };
    let mounted = ''; let copied: string[] = [];
    const remove = vi.spyOn(client, 'remove').mockResolvedValue();
    const spawn = vi.spyOn(client, 'spawn').mockImplementation((args, stdin, environment) => {
      expect(args[0]).toBe('run'); expect(args).toContain(image.reference); expect(args).not.toContain(selectedKey);
      expect(args).not.toContain(repository); expect(args).not.toContain('/synthetic-host-home'); expect(stdin).toBe(prompt.user);
      const mount = args[args.indexOf('--mount') + 1]!;
      expect(mount).toMatch(/,dst=\/redline-input,readonly$/u);
      mounted = mount.slice('type=bind,src='.length, mount.indexOf(',dst='));
      copied = readdirSync(mounted).sort();
      expect(statSync(dirname(mounted)).mode & 0o777).toBe(0o700);
      expect(environment).toEqual(harness === 'pi' ? { REDLINE_MODEL_API_KEY: selectedKey } : { OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: '4096' });
      if (harness === 'pi') {
        expect(args).toContain('--no-tools'); expect(args).toContain('--no-session'); expect(args).toContain('/redline-input/system-prompt.md');
        expect(readFileSync(join(mounted, 'system-prompt.md'), 'utf8')).toBe(prompt.system);
      } else {
        expect(args).toContain('--pure');
        const config = JSON.parse(readFileSync(join(mounted, 'opencode.json'), 'utf8'));
        expect(JSON.stringify(config)).toContain(selectedKey);
        const agents = Object.values(config.agent) as { prompt: string; tools: Record<string, boolean> }[];
        expect(agents).toHaveLength(1); expect(agents[0]?.prompt).toBe(prompt.system);
        expect(Object.keys(agents[0]!.tools)).toContain('bash');
        expect(Object.values(agents[0]!.tools).every(value => value === false)).toBe(true);
        expect(JSON.stringify(config)).not.toContain('unrelated-provider-key');
      }
      return processResult();
    });
    try {
      const adapter = createDockerExecutor(harness, client, image, DEFAULT_CONTAINER_LIMITS, new AbortController().signal);
      const prepared = await adapter.prepare({ model: { provider: 'mock', endpoint: 'http://model.invalid/v1', model: 'test-model' },
        credential: { provider: 'mock', value: selectedKey }, workDirectory: scratch, timeoutMs: 1000, maxOutputTokens: 4096, retryOwnership: 'caller' });
      await adapter.execute(prepared, prompt);
      expect(spawn).toHaveBeenCalledTimes(1); expect(remove).toHaveBeenCalledTimes(1); expect(existsSync(mounted)).toBe(false);
      expect(copied).toEqual(harness === 'pi' ? ['models.json', 'settings.json', 'system-prompt.md'] : ['opencode.json']);
    } finally { await client.close(); }
  });
});
