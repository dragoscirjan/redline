import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const bootstrap = await import(
  pathToFileURL(join(process.cwd(), 'packages/runner-bootstrap/bootstrap.js')).href
) as typeof import('../packages/runner-bootstrap/bootstrap.js');
const {
  MAX_BOOTSTRAP_ENVELOPE_BYTES,
  OPENCODE_COORDINATOR_SESSION_ID,
  buildOpenCodeRuntime,
  buildPiRuntime,
  parseBootstrapEnvelope,
} = bootstrap;

function serializedEnvelope(backend: 'pi' | 'opencode', overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 2,
    backend,
    prompt: 'untrusted review evidence',
    systemPrompt: 'fixed review system policy',
    model: {
      provider: 'private-provider',
      endpoint: 'https://models.example.test/v1',
      model: 'review/model',
      credential: 'selected-secret',
    },
    ...overrides,
  });
}

test('builds a minimal Pi runtime for the pinned CLI contract', () => {
  const envelope = parseBootstrapEnvelope(serializedEnvelope('pi'), 'pi');
  const plan = buildPiRuntime(envelope);
  assert.equal(plan.command, '/usr/local/bin/pi');
  assert.deepEqual(plan.arguments, [
    '--mode',
    'json',
    '--no-session',
    '--no-tools',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
    '--no-approve',
    '--system-prompt',
    '/tmp/redline/run/pi/review-policy.txt',
    '--provider',
    'private-provider',
    '--model',
    'review/model',
    '--print',
  ]);
  const settings = JSON.parse(plan.files.find((file) => file.path.endsWith('/settings.json'))?.content as string);
  const models = JSON.parse(plan.files.find((file) => file.path.endsWith('/models.json'))?.content as string);
  assert.deepEqual(settings, {});
  assert.equal(plan.files.find((file) => file.path.endsWith('/review-policy.txt'))?.content, 'fixed review system policy');
  assert.equal(plan.prompt, 'untrusted review evidence');
  assert.deepEqual(models, {
    providers: {
      'private-provider': {
        baseUrl: 'https://models.example.test/v1',
        api: 'openai-completions',
        apiKey: '$REDLINE_MODEL_CREDENTIAL',
        models: [{ id: 'review/model' }],
      },
    },
  });
  assert.equal(plan.environment.REDLINE_MODEL_CREDENTIAL, 'selected-secret');
  assert.doesNotMatch(JSON.stringify({ files: plan.files, arguments: plan.arguments }), /selected-secret/u);
});

test('builds a tool-denied OpenCode runtime with the fixed report plugin', () => {
  const envelope = parseBootstrapEnvelope(serializedEnvelope('opencode'), 'opencode');
  const plan = buildOpenCodeRuntime(envelope);
  assert.equal(plan.command, '/usr/local/bin/opencode');
  assert.deepEqual(plan.arguments, [
    'run',
    '--format',
    'json',
    '--model',
    'private-provider/review/model',
    '--title',
    'redline-review',
    '--agent',
    'redline-review',
  ]);
  const config = JSON.parse(plan.files[0]?.content as string);
  assert.deepEqual(config.plugin, ['file:///opt/redline/opencode/redline-report-plugin.js']);
  assert.deepEqual(config.permission, { '*': 'deny' });
  assert.deepEqual(config.agent['redline-review'], {
    mode: 'primary', prompt: 'fixed review system policy', permission: { '*': 'deny' },
  });
  assert.deepEqual(config.provider, {
    'private-provider': {
      npm: '@ai-sdk/openai-compatible',
      name: 'private-provider',
      options: {
        baseURL: 'https://models.example.test/v1',
        apiKey: '{env:REDLINE_MODEL_CREDENTIAL}',
      },
      models: { 'review/model': { name: 'review/model' } },
    },
  });
  const packageLock = JSON.parse(plan.files[1]?.content as string);
  assert.deepEqual(packageLock.packages[''].dependencies, { '@opencode-ai/plugin': '*' });
  assert.ok(plan.directories.includes('/tmp/redline/run/opencode/node_modules'));
  for (const name of [
    'OPENCODE_DISABLE_AUTOUPDATE',
    'OPENCODE_DISABLE_CLAUDE_CODE',
    'OPENCODE_DISABLE_DEFAULT_PLUGINS',
    'OPENCODE_DISABLE_EXTERNAL_SKILLS',
    'OPENCODE_DISABLE_LSP_DOWNLOAD',
    'OPENCODE_DISABLE_MODELS_FETCH',
    'OPENCODE_DISABLE_PROJECT_CONFIG',
  ]) {
    assert.equal(plan.environment[name], '1');
  }
  assert.equal(plan.environment.XDG_CACHE_HOME, '/tmp/redline/run/cache');
  assert.equal(plan.environment.XDG_CONFIG_HOME, '/tmp/redline/run');
  assert.equal(plan.environment.OPENCODE_CONFIG_DIR, '/tmp/redline/run/opencode');
  assert.equal(plan.environment.XDG_DATA_HOME, '/tmp/redline/run/data');
  assert.equal(plan.environment.XDG_STATE_HOME, '/tmp/redline/run/state');
  assert.equal(plan.environment.REDLINE_COORDINATOR_SESSION_ID, OPENCODE_COORDINATOR_SESSION_ID);
  assert.equal(plan.environment.REDLINE_MODEL_CREDENTIAL, 'selected-secret');
  assert.doesNotMatch(JSON.stringify({ files: plan.files, arguments: plan.arguments }), /selected-secret/u);
});

test('rejects malformed, extensible, mismatched, and control-bearing bootstrap input', () => {
  for (const serialized of [
    '{',
    'null',
    JSON.stringify({ version: 1, backend: 'pi', prompt: 'prompt', model: {}, extra: true }),
    serializedEnvelope('opencode'),
    serializedEnvelope('pi', { prompt: 'bad\u0000prompt' }),
    JSON.stringify({
      version: 1,
      backend: 'pi',
      prompt: 'prompt',
      model: {
        provider: 'private-provider',
        endpoint: 'file:///tmp/model',
        model: 'review\u0085model',
        credential: 'secret',
      },
    }),
    JSON.stringify({
      version: 1,
      backend: 'pi',
      prompt: 'prompt',
      model: {
        provider: 'private-provider',
        endpoint: 'https://models.example.test/v1',
        model: 'review/model',
        credential: 'secret\u0085suffix',
      },
    }),
  ]) {
    assert.throws(() => parseBootstrapEnvelope(serialized, 'pi'));
  }
  assert.throws(
    () => parseBootstrapEnvelope('x'.repeat(MAX_BOOTSTRAP_ENVELOPE_BYTES + 1), 'pi'),
    /byte limit/u,
  );
});

test('requires v2 fixed system policy and rejects legacy or missing policy envelopes', () => {
  assert.throws(() => parseBootstrapEnvelope(serializedEnvelope('pi', { version: 1 }), 'pi'), /version is unsupported/u);
  assert.throws(() => parseBootstrapEnvelope(serializedEnvelope('pi', { systemPrompt: '' }), 'pi'), /system policy is invalid/u);
  assert.throws(() => parseBootstrapEnvelope(serializedEnvelope('pi', { systemPrompt: 'bad\u0000policy' }), 'pi'), /system policy is invalid/u);
});

test('runner images use the fixed bootstrap entrypoint', async () => {
  const [base, pi, opencode] = await Promise.all([
    readFile('packages/base-runner/Dockerfile', 'utf8'),
    readFile('packages/pi-runner/Dockerfile', 'utf8'),
    readFile('packages/opencode-runner/Dockerfile', 'utf8'),
  ]);
  assert.match(base, /COPY packages\/runner-bootstrap\/bootstrap\.js \/opt\/redline\/bootstrap\.js/u);
  assert.match(base, /chmod 0555 \/opt\/redline\/bootstrap\.js/u);
  assert.match(pi, /ENTRYPOINT \["node", "\/opt\/redline\/bootstrap\.js", "pi"\]/u);
  assert.match(opencode, /ENTRYPOINT \["node", "\/opt\/redline\/bootstrap\.js", "opencode"\]/u);
});
