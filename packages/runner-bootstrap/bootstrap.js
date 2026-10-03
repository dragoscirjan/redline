import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAX_BOOTSTRAP_ENVELOPE_BYTES = 2 * 1024 * 1024;
export const OPENCODE_COORDINATOR_SESSION_ID = 'redline-coordinator';

const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
const RUN_ROOT = '/tmp/redline/run';
const FIXED_RUNTIME_ENVIRONMENT = Object.freeze({
  PATH: '/usr/local/bin:/usr/bin:/bin',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
});

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value, allowed, label) {
  const allowedKeys = new Set(allowed);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowedKeys.has(key)) || allowed.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`${label} has an invalid shape`);
  }
}

function boundedString(value, maximumLength, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    value !== value.trim() ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export function parseBootstrapEnvelope(serialized, expectedBackend) {
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_BOOTSTRAP_ENVELOPE_BYTES) {
    throw new Error('bootstrap envelope exceeds its byte limit');
  }
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error('bootstrap envelope must be valid JSON');
  }
  if (!isRecord(parsed)) throw new Error('bootstrap envelope must be a JSON object');
  exactKeys(parsed, ['version', 'backend', 'prompt', 'systemPrompt', 'model'], 'bootstrap envelope');
  if (parsed.version !== 2) throw new Error('bootstrap envelope version is unsupported');
  if ((expectedBackend !== 'pi' && expectedBackend !== 'opencode') || parsed.backend !== expectedBackend) {
    throw new Error('bootstrap backend does not match the runner image');
  }
  if (typeof parsed.prompt !== 'string' || parsed.prompt.length === 0 || parsed.prompt.includes('\0')) {
    throw new Error('bootstrap prompt is invalid');
  }
  if (typeof parsed.systemPrompt !== 'string' || parsed.systemPrompt.length === 0 || parsed.systemPrompt.includes('\0')) {
    throw new Error('bootstrap system policy is invalid');
  }
  if (!isRecord(parsed.model)) throw new Error('bootstrap model must be a JSON object');
  exactKeys(parsed.model, ['provider', 'endpoint', 'model', 'credential'], 'bootstrap model');
  const provider = boundedString(parsed.model.provider, 64, 'bootstrap provider');
  if (!PROVIDER_PATTERN.test(provider)) throw new Error('bootstrap provider is invalid');
  const model = boundedString(parsed.model.model, 256, 'bootstrap model identifier');
  const credential = boundedString(parsed.model.credential, 16 * 1024, 'bootstrap credential');
  const endpointValue = boundedString(parsed.model.endpoint, 2_048, 'bootstrap endpoint');
  let endpoint;
  try {
    endpoint = new URL(endpointValue);
  } catch {
    throw new Error('bootstrap endpoint must be an absolute URL');
  }
  if (
    (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash
  ) {
    throw new Error('bootstrap endpoint is unsupported');
  }
  return Object.freeze({
    version: 2,
    backend: expectedBackend,
    prompt: parsed.prompt,
    systemPrompt: parsed.systemPrompt,
    model: Object.freeze({ provider, endpoint: endpoint.toString(), model, credential }),
  });
}

export function buildPiRuntime(envelope) {
  if (envelope.backend !== 'pi') throw new Error('Pi runtime requires a Pi bootstrap envelope');
  const agentDirectory = `${RUN_ROOT}/pi`;
  return {
    directories: [agentDirectory, `${RUN_ROOT}/tmp`],
    files: [
      { path: `${agentDirectory}/settings.json`, content: '{}\n' },
      { path: `${agentDirectory}/review-policy.txt`, content: envelope.systemPrompt },
      {
        path: `${agentDirectory}/models.json`,
        content: `${JSON.stringify({
          providers: {
            [envelope.model.provider]: {
              baseUrl: envelope.model.endpoint,
              api: 'openai-completions',
              apiKey: '$REDLINE_MODEL_CREDENTIAL',
              models: [{ id: envelope.model.model }],
            },
          },
        })}\n`,
      },
    ],
    command: '/usr/local/bin/pi',
    arguments: [
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
      `${agentDirectory}/review-policy.txt`,
      '--provider',
      envelope.model.provider,
      '--model',
      envelope.model.model,
      '--print',
    ],
    environment: {
      HOME: RUN_ROOT,
      TMPDIR: `${RUN_ROOT}/tmp`,
      PI_CODING_AGENT_DIR: agentDirectory,
      PI_SETTINGS_PATH: `${agentDirectory}/settings.json`,
      REDLINE_MODEL_CREDENTIAL: envelope.model.credential,
    },
    prompt: envelope.prompt,
  };
}

export function buildOpenCodeRuntime(envelope) {
  if (envelope.backend !== 'opencode') {
    throw new Error('OpenCode runtime requires an OpenCode bootstrap envelope');
  }
  const configPath = `${RUN_ROOT}/opencode.json`;
  const configDirectory = `${RUN_ROOT}/opencode`;
  const homeDirectory = `${RUN_ROOT}/home`;
  const cacheDirectory = `${RUN_ROOT}/cache`;
  const dataDirectory = `${RUN_ROOT}/data`;
  const stateDirectory = `${RUN_ROOT}/state`;
  return {
    directories: [
      `${configDirectory}/node_modules`,
      homeDirectory,
      cacheDirectory,
      dataDirectory,
      stateDirectory,
      `${RUN_ROOT}/tmp`,
    ],
    files: [
      {
        path: configPath,
        content: `${JSON.stringify({
          $schema: 'https://opencode.ai/config.json',
          plugin: ['file:///opt/redline/opencode/redline-report-plugin.js'],
          provider: {
            [envelope.model.provider]: {
              npm: '@ai-sdk/openai-compatible',
              name: envelope.model.provider,
              options: {
                baseURL: envelope.model.endpoint,
                apiKey: '{env:REDLINE_MODEL_CREDENTIAL}',
              },
              models: {
                [envelope.model.model]: { name: envelope.model.model },
              },
            },
          },
          permission: { '*': 'deny' },
          agent: {
            'redline-review': {
              mode: 'primary',
              prompt: envelope.systemPrompt,
              permission: { '*': 'deny' },
            },
          },
        })}\n`,
      },
      {
        path: `${configDirectory}/package-lock.json`,
        content: `${JSON.stringify({
          lockfileVersion: 3,
          packages: {
            '': { dependencies: { '@opencode-ai/plugin': '*' } },
          },
        })}\n`,
      },
    ],
    command: '/usr/local/bin/opencode',
    arguments: [
      'run',
      '--format',
      'json',
      '--model',
      `${envelope.model.provider}/${envelope.model.model}`,
      '--title',
      'redline-review',
      '--agent',
      'redline-review',
    ],
    environment: {
      HOME: homeDirectory,
      TMPDIR: `${RUN_ROOT}/tmp`,
      XDG_CACHE_HOME: cacheDirectory,
      XDG_CONFIG_HOME: RUN_ROOT,
      XDG_DATA_HOME: dataDirectory,
      XDG_STATE_HOME: stateDirectory,
      OPENCODE_CONFIG: configPath,
      OPENCODE_CONFIG_DIR: configDirectory,
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      REDLINE_COORDINATOR_SESSION_ID: OPENCODE_COORDINATOR_SESSION_ID,
      REDLINE_MODEL_CREDENTIAL: envelope.model.credential,
      REDLINE_REPORT_EVENTS: '1',
    },
    prompt: envelope.prompt,
  };
}

async function readBootstrapInput() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.byteLength;
    if (bytes > MAX_BOOTSTRAP_ENVELOPE_BYTES) throw new Error('bootstrap envelope exceeds its byte limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function materializeRuntime(plan) {
  for (const directory of plan.directories) await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const file of plan.files) {
    await mkdir(dirname(file.path), { recursive: true, mode: 0o700 });
    await writeFile(file.path, file.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }
}

async function runRuntime(plan) {
  await materializeRuntime(plan);
  const child = spawn(plan.command, plan.arguments, {
    cwd: '/workspace/source',
    env: { ...FIXED_RUNTIME_ENVIRONMENT, ...plan.environment },
    stdio: ['pipe', 'inherit', 'inherit'],
    windowsHide: true,
  });
  const forwardTerm = () => child.kill('SIGTERM');
  const forwardInterrupt = () => child.kill('SIGINT');
  const forwardHangup = () => child.kill('SIGHUP');
  process.once('SIGTERM', forwardTerm);
  process.once('SIGINT', forwardInterrupt);
  process.once('SIGHUP', forwardHangup);
  child.stdin.end(plan.prompt, 'utf8');
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  process.removeListener('SIGTERM', forwardTerm);
  process.removeListener('SIGINT', forwardInterrupt);
  process.removeListener('SIGHUP', forwardHangup);
  if (result.signal) process.kill(process.pid, result.signal);
  return result.code ?? 1;
}

export async function main(arguments_ = process.argv.slice(2)) {
  if (arguments_.length !== 1 || (arguments_[0] !== 'pi' && arguments_[0] !== 'opencode')) {
    process.stderr.write('redline-runner-bootstrap: expected one fixed backend argument\n');
    return 2;
  }
  try {
    const envelope = parseBootstrapEnvelope(await readBootstrapInput(), arguments_[0]);
    const plan = envelope.backend === 'pi' ? buildPiRuntime(envelope) : buildOpenCodeRuntime(envelope);
    return await runRuntime(plan);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'runner bootstrap failed';
    process.stderr.write(`redline-runner-bootstrap: ${message}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(realpathSync(invokedPath)).href) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
