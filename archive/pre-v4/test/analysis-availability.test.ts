import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { integrationServers, integrationToolNames, type PreparedAnalysis } from '../src/harness-executor/analysis.ts';
import { createPiExecutor } from '../src/harness-executor/pi-executor.ts';
import { createOpenCodeExecutor } from '../src/harness-executor/opencode-executor.ts';
import type { ProcessSpawner } from '../src/harness-executor/process-runner.ts';

describe('optional analysis availability', () => {
  for (const harness of ['pi', 'opencode'] as const) {
    it(harness + ' still executes a prompt when optional integration preparation fails', async () => {
      const root = await mkdtemp(join(tmpdir(), 'redline-optional-analysis-'));
      try {
        const requests: Parameters<ProcessSpawner['spawn']>[0][] = [];
        const output = harness === 'pi' ? JSON.stringify({ type: 'turn_end', message: { role: 'assistant',
          content: [{ type: 'text', text: 'model-answer' }], stopReason: 'stop' } })
          : JSON.stringify({ type: 'text', part: { type: 'text', text: 'model-answer' } });
        const spawner: ProcessSpawner = { spawn(request) {
          requests.push(request);
          return { stdout: (async function* () { yield new TextEncoder().encode(output); })(),
            stderr: (async function* () {})(), wait: async () => ({ code: 0 }), kill: () => undefined };
        } };
        const executor = harness === 'pi' ? createPiExecutor({ spawner }) : createOpenCodeExecutor({ spawner });
        const prepared = await executor.prepare({ model: { provider: 'mock', endpoint: 'http://127.0.0.1:1/v1', model: 'fixture' },
          credential: { provider: 'mock', value: 'selected-synthetic-key' }, timeoutMs: 1000, workDirectory: root,
          analysis: { sourceDirectory: join(root, 'missing-capture'), files: [], head: 'a'.repeat(40), graphEnabled: true, timeoutMs: 1000 } });
        expect(prepared.analysis?.statuses).toHaveLength(5);
        expect(prepared.analysis?.statuses.every(status => status.status !== 'ready')).toBe(true);
        const result = await executor.execute(prepared, { system: 'fixed policy', user: 'captured diff' });
        expect(result).toMatchObject({ status: 'succeeded', text: 'model-answer' });
        expect(requests).toHaveLength(1);
        const request = requests[0]!;
        if (harness === 'pi') {
          expect(request.args).toContain('--no-tools');
          const config = JSON.parse(await readFile(join(String(request.env?.['PI_CODING_AGENT_DIR']), 'mcp.json'), 'utf8'));
          expect(config).toEqual({ autoEnableCodemode: false, mcpServers: {} });
        } else {
          const config = JSON.parse(await readFile(String(request.env?.['OPENCODE_CONFIG']), 'utf8'));
          expect(config.mcp).toEqual({});
          expect(config.agent['redline-review'].permission).toEqual({ '*': 'deny' });
          expect(Object.values(config.agent['redline-review'].tools).every(value => value === false)).toBe(true);
        }
        expect(JSON.stringify(prepared.analysis)).not.toContain('selected-synthetic-key');
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }
  it('exposes only fixed native MCP names and strips model credentials from MCP children', () => {
    const analysis: PreparedAnalysis = { manifestFile: '/private/analysis/manifest.json', launcher: '/trusted/redline-analysis.mjs',
      command: '/trusted/node', statuses: [], backends: ['context-mode', 'sequential-thinking'] };
    expect(integrationToolNames(analysis, 'pi')).toEqual([
      'mcp__redline_context_mode__ctx_index', 'mcp__redline_context_mode__ctx_search',
      'mcp__redline_sequential_thinking__sequentialthinking',
    ]);
    expect(integrationToolNames(analysis, 'opencode')).toEqual([
      'redline_context_mode_ctx_index', 'redline_context_mode_ctx_search',
      'redline_sequential_thinking_sequentialthinking',
    ]);
    const pi = integrationServers(analysis, 'pi') as Record<string, { env: Record<string, string>; toolExposure: Record<string, string>; exposure: string }>;
    const opencode = integrationServers(analysis, 'opencode') as Record<string, { environment: Record<string, string>; command: string[] }>;
    for (const name of Object.keys(pi)) {
      expect(pi[name]!.env['REDLINE_MODEL_API_KEY']).toBe('');
      expect(opencode[name]!.environment['REDLINE_MODEL_API_KEY']).toBe('');
      expect(pi[name]!.env['OPENCODE_CONFIG']).toBe('');
      expect(pi[name]!.exposure).toBe('hidden');
      expect(Object.values(pi[name]!.toolExposure).every(mode => mode === 'direct')).toBe(true);
      expect(opencode[name]!.command.slice(0, 3)).toEqual(['/trusted/node', '/trusted/redline-analysis.mjs', 'serve']);
    }
    expect(JSON.stringify([pi, opencode])).not.toContain('ctx_execute');
  });
});
