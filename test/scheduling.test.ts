import { describe, expect, it } from 'vitest';
import { simulateScheduling } from '../src/benchmark/scheduling.ts';
import { scheduleBySize, workloadBound } from '../src/review/scheduling.ts';
describe('bounded deterministic scheduling', () => {
  const tasks = Array.from({ length: 20 }, (_, manifestIndex) => ({ manifestIndex,
    estimatedPromptBytes: manifestIndex < 4 ? 10000 : 100,
    durationMs: manifestIndex < 4 ? 240000 : 30000 }));
  it('measures deadline coverage on the same synthetic corpus without claiming universal latency improvements', () => {
    const largest = simulateScheduling(tasks, 4, 180000, 'largest-first');
    const mixed = simulateScheduling(tasks, 4, 180000, 'mixed');
    expect(largest.completed).toBe(0); expect(mixed.completed).toBe(3);
    const fullLargest = simulateScheduling(tasks, 4, 600000, 'largest-first');
    const fullMixed = simulateScheduling(tasks, 4, 600000, 'mixed');
    expect(fullLargest.completed).toBe(20); expect(fullMixed.completed).toBe(20);
    expect(fullLargest.elapsedMs).toBeLessThanOrEqual(fullMixed.elapsedMs);
  });
  it('records a counterexample instead of changing defaults from one favorable corpus', () => {
    const counterexample = [8000, 7000, 6000, 5000].map((durationMs, manifestIndex) => ({ manifestIndex, estimatedPromptBytes: durationMs, durationMs }));
    expect(simulateScheduling(counterexample, 2, 30000, 'largest-first').elapsedMs).toBe(13000);
    expect(simulateScheduling(counterexample, 2, 30000, 'mixed').elapsedMs).toBe(14000);
  });
  it('keeps serial traversal, deterministic ties, all tasks exactly once, and handles empty queues', () => {
    expect(scheduleBySize(tasks, 1, 'mixed')).toEqual(tasks);
    const ids = scheduleBySize(tasks, 4, 'mixed').map((task) => task.manifestIndex);
    expect(new Set(ids).size).toBe(tasks.length);
    expect(ids.slice(0, 4)).toEqual([0, 19, 1, 18]);
    expect(scheduleBySize([], 4, 'mixed')).toEqual([]);
  });
  it('reports only a worst-case bound and never expands limits', () => {
    expect(workloadBound(20, 4, 240000, 600000)).toEqual({ files: 20, workers: 4, maximumExecutionMs: 1200000, remainingMs: 600000, mayExceedDeadline: true });
    expect(workloadBound(0, 4, 240000, 600000).maximumExecutionMs).toBe(0);
  });
});
