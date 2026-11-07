// Trusted synthetic fixture. No reviewed repository code is executed.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { prepareAnalysis, disposeAnalysis } from '/opt/redline/src/harness-executor/analysis.ts';

await mkdir('/tmp/probe/source', { recursive: true });
await mkdir('/tmp/probe/client', { recursive: true });
await writeFile('/tmp/probe/source/value.ts', 'export function value() { return 42; }');
await writeFile('/tmp/probe/source/value.py', 'def value():\n    return 42\n');
const prepared = await prepareAnalysis({
  sourceDirectory: '/tmp/probe/source', repositoryDirectory: '/tmp/probe/source',
  files: ['value.ts', 'value.py'], head: 'a'.repeat(40), graphEnabled: true, timeoutMs: 20000,
}, '/tmp/probe/work', 'pi', 'pi');
try {
  const manifest = JSON.parse(await readFile(prepared.manifestFile, 'utf8'));
  const { Client } = await import(pathToFileURL(manifest.sdk.client));
  const { StdioClientTransport } = await import(pathToFileURL(manifest.sdk.clientTransport));
  async function withClient(component, check) {
    const client = new Client({ name: 'scope-check', version: '1.0.0' }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: prepared.command, args: [prepared.launcher, 'serve', prepared.manifestFile, component],
      env: { PATH: process.env.PATH, HOME: '/tmp/probe/client' }, stderr: 'pipe',
    });
    transport.stderr?.resume();
    try { await client.connect(transport, { timeout: 10000 }); await check(client); }
    finally { await client.close(); }
  }
  for (const component of ['cgc', 'gitnexus']) {
    await withClient(component, async client => {
      const response = await client.callTool({
        name: component === 'cgc' ? 'find_code' : 'context',
        arguments: component === 'cgc' ? { query: 'value' } : { name: 'value', file_path: 'value.ts' },
      }, undefined, { timeout: 15000 });
      if (response.isError || !JSON.stringify(response).includes('value')) throw new Error('captured symbol unavailable');
      if (component === 'cgc') {
        const data = JSON.parse(response.content.find(part => part.type === 'text').text);
        if (data.success !== true || data.results.functions_by_name.length === 0) throw new Error('captured CGC function unavailable');
      }
      const denied = await client.callTool({ name: 'ctx_execute', arguments: { code: 'forbidden' } }, undefined, { timeout: 3000 });
      if (denied.isError !== true) throw new Error('admin tool accepted');
    });
  }
  // A dependency disappearing after preflight must not prevent native tool
  // registration or turn its later call into a fatal prompt error.
  manifest.backends.find(backend => backend.component === 'cgc').command = '/unavailable/cgc';
  await writeFile(prepared.manifestFile, JSON.stringify(manifest));
  await withClient('cgc', async client => {
    const response = await client.callTool({ name: 'get_repository_stats', arguments: {} }, undefined, { timeout: 5000 });
    if (response.isError !== true) throw new Error('broken backend not reported');
  });
  console.log(JSON.stringify(prepared.statuses));
} finally { await disposeAnalysis(prepared); }
