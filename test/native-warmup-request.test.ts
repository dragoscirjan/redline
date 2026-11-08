import { describe, expect, it } from 'vitest';
import { nativePiExtension } from '../src/harness-executor/native-pi.ts';

/** Load the generated request extension against a synthetic Pi API to inspect warmup and file-review controls without a model call. */
function load(warmup: boolean, requiredTool?: string) {
  const handlers = new Map<string, (event: Record<string, unknown>) => Record<string, unknown> | void>();
  const source = nativePiExtension({ provider: 'openrouter', endpoint: 'http://127.0.0.1/v1', model: 'mock' }, 4096,
    'openrouter-json', { system: 'trusted', user: 'trusted', ...(requiredTool === undefined ? {} : { requiredTool }), ...(warmup ? { toolUse: 'required-first' as const } : { responseSchema: { type: 'object' } }) });
  const factory = new Function(source.replace('export default function', 'return function'))() as (pi: unknown) => void;
  factory({ registerProvider() {}, on(name: string, callback: (event: Record<string, unknown>) => Record<string, unknown> | void) { handlers.set(name, callback); },
    getAllTools: () => [{ name: 'codemode' }, { name: 'extra_native_tool' }], getActiveTools: () => ['codemode', 'extra_native_tool'], appendEntry() {} });
  return handlers;
}
describe('native Pi warmup request contract', () => {
  it('requires native discovery on the first request without forcing final JSON during tool work', () => {
    const hooks = load(true);
    const payload = { tools: [{ type: 'function', function: { name: 'codemode' } }, { type: 'function', function: { name: 'extra_native_tool' } }],
      reasoning: { enabled: true }, response_format: { type: 'json_schema' } };
    const first = hooks.get('before_provider_request')!({ payload });
    expect(first?.tool_choice).toEqual({ type: 'function', function: { name: 'codemode' } });
    expect(first).not.toHaveProperty('response_format'); expect(first?.tools).toEqual(payload.tools);
    expect(first?.reasoning).toEqual({ enabled: true }); expect(first?.max_tokens).toBe(4096);
    hooks.get('tool_execution_start')!({ toolName: 'codemode' });
    const next = hooks.get('before_provider_request')!({ payload });
    expect(next).not.toHaveProperty('tool_choice'); expect(next).not.toHaveProperty('response_format');
  });
  it('does not change strict structured output for the actual file review', () => {
    const payload = load(false).get('before_provider_request')!({ payload: { tools: [], reasoning: { effort: 'high' } } });
    expect(payload?.response_format).toMatchObject({ type: 'json_schema' });
    expect(payload?.reasoning).toEqual({ effort: 'high' });
  });
  it('requests the selected index query in a fresh file process while retaining its strict schema', () => {
    const payload = load(false, 'cgc_query').get('before_provider_request')!({ payload: { tools: [{ function: { name: 'cgc_query' } }] } });
    expect(payload?.tool_choice).toEqual({ type: 'function', function: { name: 'cgc_query' } });
    expect(payload?.response_format).toMatchObject({ type: 'json_schema' });
  });
  it('does not invent a discovery tool when only other native tools are declared', () => {
    const payload = load(true).get('before_provider_request')!({ payload: { tools: [{ function: { name: 'bash' } }] } });
    expect(payload?.tool_choice).toBe('required');
  });
});
