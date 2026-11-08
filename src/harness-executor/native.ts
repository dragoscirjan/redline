/** Native configuration belongs to the harness; Redline records bounded evidence, not tool arguments. */
import type { HarnessName } from './types.ts';

export interface NativeHarnessContext {
  readonly directory: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
}
export interface NativeToolCall {
  readonly name: string;
  readonly started: number;
  readonly succeeded: number;
  readonly failed: number;
}
export interface NativeServerObservation {
  readonly name: string;
  readonly status: 'connected' | 'failed' | 'disabled';
}
export interface NativeToolEvidence {
  readonly servers?: readonly NativeServerObservation[];
  readonly discovery?: 'complete' | 'incomplete';
  readonly catalogueSource: 'harness-catalogue' | 'observed-calls';
  readonly catalogue: readonly string[];
  readonly calls: readonly NativeToolCall[];
  readonly truncated: boolean;
}

/** Keep native configuration variables and user-owned MCP credentials, never Redline's publication context. */
export function nativeEnvironment(environment: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const publicationToken = environment.REDLINE_PUBLISH_TOKEN;
  return Object.fromEntries(Object.entries(environment).filter(([key, value]) => !key.startsWith('REDLINE_')
    && (publicationToken === undefined || value !== publicationToken)));
}
/** Merge bounded catalogues, server observations, and call counts without promoting visibility into successful execution. */
export function mergeNativeToolEvidence(items: readonly NativeToolEvidence[]): NativeToolEvidence {
  const servers = new Map<string, NativeServerObservation>();
  let truncated = items.some(item => item.truncated);
  for (const item of items) for (const server of item.servers ?? []) {
    if (servers.size < 256 || servers.has(server.name)) servers.set(server.name, server);
    else truncated = true;
  }
  const catalogue = new Set<string>();
  const calls = new Map<string, { name: string; started: number; succeeded: number; failed: number }>();
  for (const item of items) {
    for (const tool of item.catalogue) {
      if (catalogue.size < 512 || catalogue.has(tool)) catalogue.add(tool); else truncated = true;
    }
    for (const call of item.calls) {
      if (!calls.has(call.name) && calls.size >= 512) { truncated = true; continue; }
      const total = calls.get(call.name) ?? { name: call.name, started: 0, succeeded: 0, failed: 0 };
      total.started += call.started; total.succeeded += call.succeeded; total.failed += call.failed;
      calls.set(call.name, total);
    }
  }
  return { ...(servers.size === 0 ? {} : { servers: [...servers.values()] }),
    ...(items.some(item => item.discovery !== undefined) ? { discovery: items.some(item => item.discovery === 'complete') ? 'complete' as const : 'incomplete' as const } : {}),
    catalogueSource: items.some(item => item.catalogueSource === 'harness-catalogue') ? 'harness-catalogue' : 'observed-calls',
    catalogue: [...catalogue].sort(), calls: [...calls.values()].sort((a, b) => a.name.localeCompare(b.name)), truncated };
}

/** Absence from an observed catalog is not proof that a package is uninstalled. */
export function nativeRequestedTools(evidence: NativeToolEvidence) {
  const patterns = {
    cgc: /(?:find_code|get_repository_stats|analyze_code_relationships)$/iu,
    gitnexus: /gitnexus.*(?:query|context|impact)$/iu,
    'context-mode': /(?:ctx_index|ctx_search)$/iu,
    'sequential-thinking': /sequentialthinking$/iu,
  };
  const aliases: Record<string, RegExp> = { cgc: /cgc|codegraphcontext/iu, gitnexus: /gitnexus/iu,
    'context-mode': /context.?mode|memory.?context/iu, 'sequential-thinking': /sequential.?thinking/iu };
  return Object.entries(patterns).map(([component, pattern]) => {
    const server = evidence.servers?.find(row => aliases[component]?.test(row.name));
    return { component, observation: evidence.catalogue.some(tool => pattern.test(tool)) ? 'observed' as const
      : server?.status ?? 'not-observed' as const };
  });
}

/** Ignore non-record native events before reading bounded observation metadata. */
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
/** Restrict persisted native tool identifiers to a bounded printable alphabet. */
function name(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,160}$/u.test(value);
}

/** Read only native tool names, call identities and terminal states. Never retain inputs, outputs or reasoning. */
export function nativeToolEvidence(stdout: string, harness: HarnessName, captureTruncated = false): NativeToolEvidence {
  const catalogue = new Set<string>();
  const calls = new Map<string, { name: string; outcome?: boolean }>();
  let catalogueSource: NativeToolEvidence['catalogueSource'] = 'observed-calls';
  let truncated = captureTruncated;
  const addName = (value: unknown): void => {
    if (!name(value)) return;
    if (catalogue.size < 512 || catalogue.has(value)) catalogue.add(value);
    else truncated = true;
  };
  for (const line of stdout.split('\n')) {
    let event: Record<string, unknown> | undefined;
    try { event = record(JSON.parse(line)); } catch { continue; }
    if (event === undefined) continue;
    const entry = record(event['entry']);
    if (harness === 'pi' && event['type'] === 'entry_appended' && entry?.['customType'] === 'redline-tool-catalog') {
      const data = record(entry['data']);
      if (data?.['truncated'] === true) truncated = true;
      const tools = data?.['tools'];
      if (Array.isArray(tools)) {
        catalogueSource = 'harness-catalogue';
        for (const tool of tools) addName(tool);
      }
      continue;
    }
    const part = record(event['part']);
    const state = record(part?.['state']);
    const isPi = harness === 'pi' && ['tool_execution_start', 'tool_execution_end'].includes(String(event['type']));
    const isOpenCode = harness === 'opencode' && event['type'] === 'tool_use';
    if (!isPi && !isOpenCode) continue;
    const tool = isPi ? event['toolName'] : part?.['tool'];
    const id = isPi ? event['toolCallId'] : part?.['callID'] ?? part?.['id'];
    if (!name(tool) || typeof id !== 'string' || id.length > 256 || /\p{Cc}/u.test(id)) continue;
    /** Bound the observed catalogue and flag truncation instead of retaining unlimited native metadata. */
    addName(tool);
    if (!calls.has(id)) {
      if (calls.size >= 512) { truncated = true; continue; }
      calls.set(id, { name: tool });
    }
    const call = calls.get(id);
    if (call === undefined || call.name !== tool || call.outcome !== undefined) continue;
    if (isPi && event['type'] === 'tool_execution_end') call.outcome = event['isError'] !== true;
    if (isOpenCode && ['completed', 'error'].includes(String(state?.['status']))) call.outcome = state?.['status'] === 'completed';
  }
  const totals = new Map<string, { name: string; started: number; succeeded: number; failed: number }>();
  for (const call of calls.values()) {
    const total = totals.get(call.name) ?? { name: call.name, started: 0, succeeded: 0, failed: 0 };
    total.started += 1;
    if (call.outcome === true) total.succeeded += 1;
    if (call.outcome === false) total.failed += 1;
    totals.set(call.name, total);
  }
  return { catalogueSource, catalogue: [...catalogue].sort(), calls: [...totals.values()].sort((a, b) => a.name.localeCompare(b.name)), truncated };
}
