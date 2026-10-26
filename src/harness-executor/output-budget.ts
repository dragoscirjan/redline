/** Trusted generation limits, separate from deadlines and context-window size. */
export const MIN_OUTPUT_TOKENS = 1_024;
export const MAX_OUTPUT_TOKENS = 262_144;

export function validateOutputTokens(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_OUTPUT_TOKENS || value > MAX_OUTPUT_TOKENS) {
    throw new Error(`max-output-tokens must be an integer from ${MIN_OUTPUT_TOKENS} through ${MAX_OUTPUT_TOKENS}`);
  }
  return value;
}

export function parseOutputTokens(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]{0,5}$/u.test(value)) throw new Error('max-output-tokens must be a decimal integer');
  return validateOutputTokens(Number(value));
}

/** Keep default capture unchanged; accommodate larger bounded NDJSON streams. */
export function outputCaptureBytes(tokens: number | undefined): number {
  return Math.max(8 * 1024 * 1024, (tokens === undefined ? 0 : validateOutputTokens(tokens)) * 256);
}
