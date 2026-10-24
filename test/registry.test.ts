import { describe, expect, it } from 'vitest';
import { createHarnessExecutor, isHarnessName } from '../src/harness-executor/registry.ts';
import { EchoHarnessExecutor } from '../src/harness-executor/echo-executor.ts';

describe('createHarnessExecutor', () => {
  it('resolves every registered harness', () => {
    expect(createHarnessExecutor('echo')).toBeInstanceOf(EchoHarnessExecutor);
    expect(createHarnessExecutor('pi').harness).toBe('pi');
    expect(createHarnessExecutor('opencode').harness).toBe('opencode');
  });

  it('validates harness names', () => {
    expect(isHarnessName('echo')).toBe(true);
    expect(isHarnessName('claude')).toBe(false);
    expect(isHarnessName('')).toBe(false);
  });
});
