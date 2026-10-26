/** Size is a heuristic, not a model latency or cost prediction. */
export type ReviewScheduling = 'largest-first' | 'mixed';

export function scheduleBySize<T extends { readonly estimatedPromptBytes: number; readonly manifestIndex: number }>(
  tasks: readonly T[], concurrency: number, policy: ReviewScheduling = 'largest-first',
): T[] {
  if (concurrency === 1) return [...tasks];
  const sorted = [...tasks].sort((a, b) => b.estimatedPromptBytes - a.estimatedPromptBytes || a.manifestIndex - b.manifestIndex);
  if (policy === 'largest-first') return sorted;
  const result: T[] = [];
  let left = 0; let right = sorted.length - 1;
  while (left <= right) {
    result.push(sorted[left++]!);
    if (left <= right) result.push(sorted[right--]!);
  }
  return result;
}

export function workloadBound(files: number, workers: number, fileTimeoutMs: number, remainingMs: number) {
  const maximumExecutionMs = Math.ceil(files / workers) * fileTimeoutMs;
  return { files, workers, maximumExecutionMs, remainingMs, mayExceedDeadline: maximumExecutionMs > remainingMs };
}
