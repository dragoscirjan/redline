import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analysisTools, authorizeAnalysisCall, type AnalysisScope } from '../src/harness-executor/analysis-policy.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function scope(): Promise<AnalysisScope> {
  const root = await mkdtemp(join(tmpdir(), 'redline-analysis-')); roots.push(root);
  const source = join(root, 'source'); await mkdir(source); await mkdir(join(source, 'src'));
  await writeFile(join(source, 'src/value.ts'), 'export const value = 42;\n');
  await writeFile(join(root, 'outside.txt'), 'outside source');
  return { source, graphSource: source, sourceLabel: 'captured-head' };
}

describe('captured-source MCP permissions', () => {
  it('exposes only explicit analysis tools', () => {
    expect(analysisTools('context-mode').map(tool => tool.name)).toEqual(['ctx_index', 'ctx_search']);
    expect(analysisTools('sequential-thinking').map(tool => tool.name)).toEqual(['sequentialthinking']);
    expect(analysisTools('gitnexus').map(tool => tool.name)).toEqual(['query', 'context', 'impact']);
    expect(analysisTools('cgc').map(tool => tool.name)).toEqual(['find_code', 'analyze_code_relationships', 'get_repository_stats']);
  });
  it.each([
    ['context-mode', 'ctx_execute'], ['context-mode', 'ctx_execute_file'], ['context-mode', 'ctx_purge'],
    ['context-mode', 'ctx_fetch_and_index'], ['context-mode', 'ctx_upgrade'], ['cgc', 'execute_cypher_query'],
    ['cgc', 'add_code_to_graph'], ['cgc', 'delete_repository'], ['gitnexus', 'rename'], ['gitnexus', 'cypher'],
  ] as const)('denies %s/%s before contacting a server', async (component, name) => {
    await expect(authorizeAnalysisCall(component, name, {}, await scope())).rejects.toThrow();
  });
  it('indexes exact captured bytes, never model-supplied content or arbitrary paths', async () => {
    const captured = await scope();
    expect(await authorizeAnalysisCall('context-mode', 'ctx_index', { path: 'src/value.ts' }, captured))
      .toEqual({ content: 'export const value = 42;\n', source: 'captured-head:src/value.ts' });
    await expect(authorizeAnalysisCall('context-mode', 'ctx_index', { content: 'invented' }, captured)).rejects.toThrow();
    for (const path of ['../outside.txt', '/etc/passwd', 'src/../../outside.txt', 'C:\\secret', 'src\\value.ts']) {
      await expect(authorizeAnalysisCall('context-mode', 'ctx_index', { path }, captured)).rejects.toThrow();
    }
  });
  it.runIf(process.platform !== 'win32')('rejects symlink reads and oversized source', async () => {
    const captured = await scope();
    await symlink(join(captured.source, '../outside.txt'), join(captured.source, 'link.txt'));
    await expect(authorizeAnalysisCall('context-mode', 'ctx_index', { path: 'link.txt' }, captured)).rejects.toThrow();
    await writeFile(join(captured.source, 'large.txt'), 'x'.repeat(128 * 1024 + 1));
    await expect(authorizeAnalysisCall('context-mode', 'ctx_index', { path: 'large.txt' }, captured)).rejects.toThrow();
  });
  it('rejects captured files outside the approved analysis subset and non-regular paths', async () => {
    const captured = await scope();
    const selected = { ...captured, files: ['src/value.ts'] };
    await writeFile(join(captured.source, 'unselected.ts'), 'export const unrelated = 1;');
    await expect(authorizeAnalysisCall('context-mode', 'ctx_index', { path: 'unselected.ts' }, selected)).rejects.toThrow();
    await expect(authorizeAnalysisCall('gitnexus', 'context', { name: 'unrelated', file_path: 'unselected.ts' }, selected)).rejects.toThrow();
    await expect(authorizeAnalysisCall('context-mode', 'ctx_index', { path: 'src' }, captured)).rejects.toThrow();
  });
  it('confines context searches to this capture and rejects session/admin selectors', async () => {
    const captured = await scope();
    expect(await authorizeAnalysisCall('context-mode', 'ctx_search', { queries: ['value'] }, captured))
      .toEqual({ queries: ['value'], source: 'captured-head', limit: 3, sort: 'relevance' });
    for (const args of [{ queries: ['value'], project: '/home/owner' }, { queries: ['value'], sort: 'timeline' },
      { queries: ['value'], source: 'other-review' }, { queries: Array(20).fill('value') }]) {
      await expect(authorizeAnalysisCall('context-mode', 'ctx_search', args, captured)).rejects.toThrow();
    }
  });
  it('pins allowed graph tool arguments and their resource limits', async () => {
    const captured = { ...await scope(), files: ['src/value.ts'] };
    expect(await authorizeAnalysisCall('gitnexus', 'query', { search_query: 'value' }, captured)).toEqual({
      search_query: 'value', limit: 5, max_symbols: 10, maxTokens: 2000, include_content: false,
    });
    expect(await authorizeAnalysisCall('gitnexus', 'context', { name: 'value', file_path: 'src/value.ts' }, captured)).toEqual({
      name: 'value', file_path: 'src/value.ts', include_content: false, maxTokens: 2000,
    });
    expect(await authorizeAnalysisCall('gitnexus', 'impact', { target: 'value', direction: 'upstream', maxDepth: 3 }, captured)).toEqual({
      target: 'value', direction: 'upstream', maxDepth: 3, crossDepth: 0, mode: 'callgraph', limit: 20, maxTokens: 2000, timeoutMs: 3000,
    });
    expect(await authorizeAnalysisCall('cgc', 'analyze_code_relationships', { query_type: 'find_callers', target: 'value', context: 'value' }, captured)).toEqual({
      query_type: 'find_callers', target: 'value', repo_path: captured.graphSource, depth: 2, context: 'value',
    });
    await expect(authorizeAnalysisCall('gitnexus', 'impact', { target: 'value', direction: 'upstream', maxDepth: 4 }, captured)).rejects.toThrow();
  });
  it('binds graph queries to the captured repository, not model-selected state', async () => {
    const captured = await scope();
    expect(await authorizeAnalysisCall('cgc', 'find_code', { query: 'value' }, captured))
      .toEqual({ query: 'value', repo_path: captured.graphSource, fuzzy_search: false });
    for (const args of [{ query: 'value', repo_path: '/home/owner' }, { query: 'value', graph_name: 'private' },
      { query: "value'); DELETE n" }]) {
      await expect(authorizeAnalysisCall('cgc', 'find_code', args, captured)).rejects.toThrow();
    }
    await expect(authorizeAnalysisCall('gitnexus', 'query', { search_query: 'value', repo: 'other' }, captured)).rejects.toThrow();
    await expect(authorizeAnalysisCall('gitnexus', 'impact', { target: 'value', direction: 'upstream', maxDepth: 1000 }, captured)).rejects.toThrow();
  });
});
