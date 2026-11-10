/** Deterministic synthetic scheduling experiment. Durations are inputs, not live latency predictions. */
import { scheduleBySize, type ReviewScheduling } from '../review/scheduling.ts';
export interface SchedulingSample { readonly manifestIndex: number; readonly estimatedPromptBytes: number; readonly durationMs: number }
export function simulateScheduling(samples: readonly SchedulingSample[], workers: number, deadlineMs: number, policy: ReviewScheduling) {
  if (!Number.isInteger(workers) || workers < 1 || workers > 8 || samples.length > 2000
    || !Number.isFinite(deadlineMs) || deadlineMs < 0
    || samples.some((item) => !Number.isSafeInteger(item.durationMs) || item.durationMs <= 0)) throw new Error('invalid bounded scheduling experiment');
  const freeAt = Array.from({ length: workers }, () => 0);
  let started = 0; let completed = 0;
  for (const sample of scheduleBySize(samples, workers, policy)) {
    const start = Math.min(...freeAt);
    if (start >= deadlineMs) break;
    const worker = freeAt.indexOf(start);
    const end = start + sample.durationMs; freeAt[worker] = end; started += 1;
    if (end <= deadlineMs) completed += 1;
  }
  return { policy, files: samples.length, workers, deadlineMs, started, completed,
    omitted: samples.length - completed, elapsedMs: Math.min(deadlineMs, Math.max(...freeAt)), assignedCompletionMs: Math.max(...freeAt) };
}
