import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdirSync, realpathSync } from 'node:fs';

const require = createRequire(realpathSync('/opt/harness/node_modules/context-mode/package.json'));
const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
const { StdioClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')));
mkdirSync('/tmp/mcp', { recursive: true });
const results = [];
for (const [name, command, args] of [
  ['sequential-thinking', 'node', ['/opt/harness/node_modules/@modelcontextprotocol/server-sequential-thinking/dist/index.js']],
  ['context-mode', 'bun', ['/opt/harness/node_modules/context-mode/cli.bundle.mjs']],
  ['gitnexus', '/opt/harness/node_modules/.bin/gitnexus', ['mcp']],
  ['cgc', '/opt/cgc/bin/cgc', ['mcp', 'start']],
]) {
  const client = new Client({ name: 'redline-image-test', version: '1.0.0' }, { capabilities: {} });
  try {
    const transport = new StdioClientTransport({
      command, args, stderr: 'ignore',
      env: { PATH: process.env.PATH, HOME: '/tmp/mcp', XDG_CACHE_HOME: '/tmp/mcp',
        DEFAULT_DATABASE: 'kuzudb', CGC_IGNORE_PROJECT_ENV: '1', ENABLE_AUTO_WATCH: 'false',
        CONTEXT_MODE_PROJECT_DIR: '/tmp/mcp' },
    });
    await client.connect(transport, { timeout: 8000 });
    const { tools } = await client.listTools();
    results.push({ name, tools: tools.map(tool => tool.name) });
  } catch (error) {
    results.push({ name, error: String(error).slice(0, 300) });
  } finally { await client.close(); }
}
console.log(JSON.stringify(results));
