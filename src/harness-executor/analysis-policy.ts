/** The same closed analysis contract is enforced below both native harnesses. */
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

export const ANALYSIS_COMPONENTS = ['cgc', 'gitnexus', 'context-mode', 'sequential-thinking'] as const;
export type AnalysisComponent = typeof ANALYSIS_COMPONENTS[number];
export interface AnalysisScope {
  readonly source: string;
  readonly graphSource: string;
  readonly sourceLabel: string;
  readonly files?: readonly string[];
}
export interface AnalysisTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}
const text = { type: 'string', minLength: 1, maxLength: 512 };
const symbol = { type: 'string', minLength: 1, maxLength: 256 };
const integer = (maximum: number) => ({ type: 'integer', minimum: 1, maximum });
function tool(name: string, description: string, properties: Readonly<Record<string, unknown>>, required: readonly string[]): AnalysisTool {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}
const relationships = ['find_callers', 'find_callees', 'find_all_callers', 'find_all_callees', 'find_importers',
  'who_modifies', 'class_hierarchy', 'overrides', 'dead_code', 'call_chain', 'module_deps', 'variable_scope',
  'find_complexity', 'find_functions_by_argument', 'find_functions_by_decorator'];
const tools: Readonly<Record<AnalysisComponent, readonly AnalysisTool[]>> = {
  'context-mode': [
    tool('ctx_index', 'Index one relative captured-head source file. Only captured bytes are indexed; no arbitrary content, URLs or execution.', { path: text }, ['path']),
    tool('ctx_search', 'Search only this captured-head index. Missing matches do not prove code is absent.', {
      queries: { type: 'array', items: text, minItems: 1, maxItems: 4 }, source: text, limit: integer(5),
    }, ['queries']),
  ],
  'sequential-thinking': [tool('sequentialthinking', 'Organize analysis without executing code or changing source.', {
    thought: { type: 'string', minLength: 1, maxLength: 4096 }, nextThoughtNeeded: { type: 'boolean' },
    thoughtNumber: integer(32), totalThoughts: integer(32), isRevision: { type: 'boolean' },
    revisesThought: integer(32), branchFromThought: integer(32), branchId: symbol, needsMoreThoughts: { type: 'boolean' },
  }, ['thought', 'nextThoughtNeeded', 'thoughtNumber', 'totalThoughts'])],
  cgc: [
    tool('find_code', 'Find symbols in the bounded captured-source graph. Graph relationships are candidates, not authoritative evidence.', { query: symbol }, ['query']),
    tool('analyze_code_relationships', 'Read relationships only in the captured-source graph. Index coverage is bounded.', {
      query_type: { type: 'string', enum: relationships }, target: symbol, context: symbol, depth: integer(3),
    }, ['query_type', 'target']),
    tool('get_repository_stats', 'Read statistics only for the bounded captured-source graph.', {}, []),
  ],
  gitnexus: [
    tool('query', 'Search the bounded captured-source graph. Missing results do not prove absence or unreachability.', { search_query: symbol, limit: integer(10) }, ['search_query']),
    tool('context', 'Read a named symbol in the captured-source graph, optionally selecting a relative captured file.', { name: symbol, file_path: text }, ['name']),
    tool('impact', 'Read bounded upstream or downstream call relationships, never modify code.', {
      target: symbol, direction: { type: 'string', enum: ['upstream', 'downstream'] }, maxDepth: integer(3),
    }, ['target', 'direction']),
  ],
};
export function analysisTools(component: AnalysisComponent): readonly AnalysisTool[] { return tools[component]; }

/** Reject non-record tool arguments before inspecting their authorized fields. */
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid analysis arguments');
  return value as Record<string, unknown>;
}
/** Require nonempty, NUL-free UTF-8 text within the analysis argument byte limit. */
function string(value: unknown, maximum = 512): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maximum || value.includes('\0')) {
    throw new Error('invalid analysis text');
  }
  return value;
}
/** Restrict graph symbols to the supported identifier alphabet rather than accepting query-language fragments. */
function identifier(value: unknown): string {
  const result = string(value, 256);
  // No Cypher/SQL quoting, operators, interpolations or statement separators.
  if (!/^[\p{L}\p{N}_./:#@()<> -]+$/u.test(result)) throw new Error('invalid analysis symbol');
  return result;
}
/** Apply defaults only to omitted bounds and reject noninteger or out-of-range analysis limits. */
function count(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error('invalid analysis bound');
  return value;
}
/** Require an actual boolean so model-supplied strings cannot change analysis control flags. */
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('invalid analysis boolean');
  return value;
}
/** Accept only normalized captured-relative paths, excluding absolute paths, drive prefixes, and traversal components. */
function path(value: unknown): string {
  const result = string(value);
  if (isAbsolute(result) || /^[A-Za-z]:/u.test(result) || result.includes('\\')
    || result.split('/').some(part => part === '' || part === '.' || part === '..')) throw new Error('path is not captured-relative');
  return result;
}
/** Read bounded regular captured source without following path-component symlinks; close the file handle on every exit. */
async function capturedText(root: string, name: string): Promise<string> {
  const canonical = await realpath(root);
  if (!(await lstat(canonical)).isDirectory()) throw new Error('captured source is unavailable');
  let current = canonical;
  for (const part of name.split('/')) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error('source symlinks are unavailable');
  }
  const target = await realpath(current);
  const rel = relative(canonical, target);
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('path escapes captured source');
  const selected = await lstat(current);
  if (!selected.isFile() || selected.size > 128 * 1024) throw new Error('captured source is not a bounded regular file');
  const handle = await open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 128 * 1024) throw new Error('captured source exceeds the read bound');
    const chunks: Buffer[] = []; let size = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(16 * 1024, 128 * 1024 + 1 - size));
      const { bytesRead } = await handle.read(buffer); if (bytesRead === 0) break;
      size += bytesRead;
      if (size > 128 * 1024) throw new Error('captured source exceeds the read bound');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally { await handle.close(); }
}

/** Authorization completes before any request reaches an optional upstream server. */
export async function authorizeAnalysisCall(component: AnalysisComponent, name: string, input: unknown, scope: AnalysisScope): Promise<Record<string, unknown>> {
  const definition = tools[component].find(candidate => candidate.name === name);
  if (definition === undefined) throw new Error('analysis tool is forbidden');
  const args = object(input);
  const properties = object(definition.inputSchema['properties']);
  if (Object.keys(args).some(key => !Object.hasOwn(properties, key))) throw new Error('analysis argument is forbidden');
  if (component === 'context-mode') {
    if (name === 'ctx_index') {
      const file = path(args['path']);
      if (scope.files !== undefined && !scope.files.includes(file)) throw new Error('file is outside the captured analysis subset');
      return { content: await capturedText(scope.source, file), source: scope.sourceLabel + ':' + file };
    }
    const queries = args['queries'];
    if (!Array.isArray(queries) || queries.length === 0 || queries.length > 4) throw new Error('invalid analysis queries');
    const source = args['source'] === undefined ? scope.sourceLabel : string(args['source']);
    if (source !== scope.sourceLabel && !source.startsWith(scope.sourceLabel + ':')) throw new Error('search escapes captured index');
    return { queries: queries.map(query => string(query)), source, limit: count(args['limit'], 3, 5), sort: 'relevance' };
  }
  if (component === 'sequential-thinking') {
    const result: Record<string, unknown> = {
      thought: string(args['thought'], 4096), nextThoughtNeeded: boolean(args['nextThoughtNeeded']),
      thoughtNumber: count(args['thoughtNumber'], 0, 32), totalThoughts: count(args['totalThoughts'], 0, 32),
    };
    if (result['thoughtNumber'] === 0 || result['totalThoughts'] === 0) throw new Error('missing thought counters');
    for (const key of ['isRevision', 'needsMoreThoughts']) if (args[key] !== undefined) result[key] = boolean(args[key]);
    for (const key of ['revisesThought', 'branchFromThought']) if (args[key] !== undefined) result[key] = count(args[key], 1, 32);
    if (args['branchId'] !== undefined) result['branchId'] = identifier(args['branchId']);
    return result;
  }
  if (component === 'cgc') {
    if (name === 'get_repository_stats') return { repo_path: scope.graphSource };
    if (name === 'find_code') return { query: identifier(args['query']), repo_path: scope.graphSource, fuzzy_search: false };
    if (!relationships.includes(string(args['query_type']))) throw new Error('relationship is forbidden');
    return { query_type: args['query_type'], target: identifier(args['target']), repo_path: scope.graphSource,
      depth: count(args['depth'], 2, 3), ...(args['context'] === undefined ? {} : { context: identifier(args['context']) }) };
  }
  if (name === 'query') return { search_query: identifier(args['search_query']), limit: count(args['limit'], 5, 10),
    max_symbols: 10, maxTokens: 2000, include_content: false };
  if (name === 'context') {
    const file = args['file_path'] === undefined ? undefined : path(args['file_path']);
    if (file !== undefined) {
      if (scope.files !== undefined && !scope.files.includes(file)) throw new Error('file is outside the captured analysis subset');
      await capturedText(scope.source, file);
    }
    return { name: identifier(args['name']), ...(file === undefined ? {} : { file_path: file }), include_content: false, maxTokens: 2000 };
  }
  if (!['upstream', 'downstream'].includes(string(args['direction']))) throw new Error('invalid impact direction');
  return { target: identifier(args['target']), direction: args['direction'], maxDepth: count(args['maxDepth'], 2, 3),
    crossDepth: 0, mode: 'callgraph', limit: 20, maxTokens: 2000, timeoutMs: 3000 };
}
