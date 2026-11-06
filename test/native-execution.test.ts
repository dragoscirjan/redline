import { describe, expect, it } from 'vitest';
import { nativeEnvironment, nativeToolEvidence, nativeOpenCodeServers, mergeNativeToolEvidence, nativeRequestedTools } from '../src/harness-executor/native.ts';

const lines = (...events: unknown[]) => events.map(event => JSON.stringify(event)).join('\n');

describe('native harness environment', () => {
  it('preserves normal configuration and MCP environment without forwarding Redline publication credentials', () => {
    const env = nativeEnvironment({ HOME: '/user', PI_CODING_AGENT_DIR: '/user/pi',
      OPENCODE_CONFIG: '/user/opencode.json', MCP_TOKEN: 'user-owned-token',
      REDLINE_MODEL_AUTH: '{"other":"unselected-model-key"}', REDLINE_PUBLISH_TOKEN: 'publication-key', GH_TOKEN: 'publication-key' });
    expect(env.HOME).toBe('/user');
    expect(env.PI_CODING_AGENT_DIR).toBe('/user/pi');
    expect(env.OPENCODE_CONFIG).toBe('/user/opencode.json');
    expect(env.MCP_TOKEN).toBe('user-owned-token');
    expect(env.REDLINE_MODEL_AUTH).toBeUndefined();
    expect(env.REDLINE_PUBLISH_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
  });
});

describe('observed native tool activity', () => {
  it('retains only native server names/states and distinguishes connections from calls', () => {
    const listing = nativeOpenCodeServers('● ✓ gitnexus connected\n│ https://private.invalid/token\n● ✗ cgc failed\n');
    expect(listing).toEqual({ discovery: 'complete', servers: [{ name: 'gitnexus', status: 'connected' }, { name: 'cgc', status: 'failed' }] });
    const report = mergeNativeToolEvidence([{ ...nativeToolEvidence('', 'opencode'), ...listing }]);
    expect(report.calls).toEqual([]);
    expect(nativeRequestedTools(report).find(row => row.component === 'gitnexus')?.observation).toBe('connected');
    expect(JSON.stringify(report)).not.toContain('private.invalid');
    expect(nativeOpenCodeServers('No MCP servers configured').discovery).toBe('complete');
    expect(nativeOpenCodeServers('partial unknown output').discovery).toBe('incomplete');
    expect(nativeOpenCodeServers('error: secret-token connected while loading config').servers).toEqual([]);
    expect(nativeOpenCodeServers(Array.from({ length: 300 }, (_, n) => `● ✓ server${n} connected`).join('\n')).discovery).toBe('incomplete');
  });

  it('distinguishes catalog visibility, successful calls, failures and unfinished calls', () => {
    const evidence = nativeToolEvidence(lines(
      { type: 'entry_appended', entry: { customType: 'redline-tool-catalog', data: { tools: ['mcp__extra__ping', 'bash'] } } },
      { type: 'tool_execution_start', toolName: 'mcp__extra__ping', toolCallId: 'one', args: { secret: 'do-not-record' } },
      { type: 'tool_execution_end', toolName: 'mcp__extra__ping', toolCallId: 'one', isError: false },
      { type: 'tool_execution_end', toolName: 'mcp__extra__ping', toolCallId: 'one', isError: false },
      { type: 'tool_execution_start', toolName: 'mcp__extra__ping', toolCallId: 'two' },
      { type: 'tool_execution_end', toolName: 'mcp__extra__ping', toolCallId: 'two', isError: true },
      { type: 'tool_execution_start', toolName: 'bash', toolCallId: 'three' },
    ), 'pi');
    expect(evidence.catalogue).toEqual(['bash', 'mcp__extra__ping']);
    expect(evidence.calls).toEqual([
      { name: 'bash', started: 1, succeeded: 0, failed: 0 },
      { name: 'mcp__extra__ping', started: 2, succeeded: 1, failed: 1 },
    ]);
    expect(JSON.stringify(evidence)).not.toContain('do-not-record');
  });

  it('records OpenCode native tool events without tool inputs or outputs', () => {
    const evidence = nativeToolEvidence(lines(
      { type: 'tool_use', part: { tool: 'extra_ping', callID: 'a', state: { status: 'running', input: { key: 'private' } } } },
      { type: 'tool_use', part: { tool: 'extra_ping', callID: 'a', state: { status: 'completed', output: 'private-result' } } },
      { type: 'tool_use', part: { tool: 'extra_ping', callID: 'b', state: { status: 'error' } } },
    ), 'opencode');
    expect(evidence.calls).toEqual([{ name: 'extra_ping', started: 2, succeeded: 1, failed: 1 }]);
    expect(evidence.catalogueSource).toBe('observed-calls');
    expect(JSON.stringify(evidence)).not.toContain('private');
  });

  it('rejects malformed names and bounds metadata independently of configured tool access', () => {
    const evidence = nativeToolEvidence(lines(
      'not-an-event', { type: 'tool_execution_start', toolName: 'bad\nname', toolCallId: 'x' },
      { type: 'entry_appended', entry: { customType: 'redline-tool-catalog', data: { tools: Array.from({ length: 600 }, (_, n) => `mcp__extra__tool${n}`) } } },
    ), 'pi');
    expect(evidence.catalogue).toHaveLength(512);
    expect(evidence.truncated).toBe(true);
    expect(evidence.calls).toEqual([]);
    const limited = nativeToolEvidence(lines({ type: 'entry_appended', entry: { customType: 'redline-tool-catalog', data: { tools: ['one'], truncated: true } } }), 'pi');
    expect(limited.truncated).toBe(true);
    expect(mergeNativeToolEvidence([limited]).truncated).toBe(true);
    expect(nativeToolEvidence('', 'pi', true).truncated).toBe(true);
  });
});
