/** Pi runtime errors only: never extract prompt, response, reasoning, or agent history. */
export interface PiFailure {
  readonly message: string;
  readonly status: number | null;
  readonly scope: 'file' | 'run';
  readonly retryable: boolean;
}

export function readPiFailure(stdout: string, fallback?: string, credential?: string): PiFailure | undefined {
  let message: string | undefined;
  for (const line of stdout.split(/\r?\n/u)) {
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (event === null || typeof event !== 'object') continue;
    const frame = event as Record<string, unknown>;
    if (frame['type'] === 'turn_start') message = undefined;
    if (frame['type'] !== 'turn_end' && frame['type'] !== 'message_end') continue;
    const value = frame['message'];
    if (value === null || typeof value !== 'object') continue;
    const assistant = value as Record<string, unknown>;
    if (assistant['role'] !== 'assistant') continue;
    message = assistant['stopReason'] === 'error' && typeof assistant['errorMessage'] === 'string'
      ? assistant['errorMessage'] : undefined;
  }
  message ??= fallback;
  if (message === undefined || message.trim() === '') return undefined;
  // Redact before classification, control filtering, truncation, and JSON escaping.
  if (credential !== undefined && credential.length > 0) {
    const forms = new Set([credential, JSON.stringify(credential).slice(1, -1)]);
    try { forms.add(encodeURIComponent(credential)); } catch { /* Malformed Unicode has no URI encoding. */ }
    const variants = [...forms].sort((a, b) => b.length - a.length);
    for (const value of variants) message = message.split(value).join('[redacted]');
  }
  message = message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  const match = /^(?:Error:\s*)?([45][0-9]{2})\b/iu.exec(message)
    ?? /\b(?:HTTP(?: error)?|APIError|(?:status|error)(?: code)?)[\s:=]+([45][0-9]{2})\b/iu.exec(message);
  const status = match === null ? null : Number(match[1]);
  const parameterFailure = /invalid (?:json )?schema|unsupported (?:request )?parameter|unknown parameter|(?:response_format|json_schema).{0,60}(?:unsupported|not supported|invalid|must be)|(?:does not support|unsupported).{0,60}(?:response_format|json_schema|reasoning)/iu.test(message);
  const authenticationFailure = /invalid.{0,20}api.?key|no api key found|authentication failed|account.{0,20}(?:disabled|suspended)/iu.test(message);
  const shared = status === 401 || status === 402 || status === 404
    || (status === 403 && authenticationFailure)
    || ((status === null || status === 400 || status === 422) && parameterFailure)
    || (status === null && authenticationFailure);
  const retryable = !shared && ((status !== null && [429, 500, 502, 503, 504].includes(status))
    || (status === null && /\bECONNRESET\b|\bETIMEDOUT\b|fetch failed|socket hang up/iu.test(message)));
  return { message, status, scope: shared ? 'run' : 'file', retryable };
}

/** Valid JSON under the existing 500-character persisted-reason bound. */
export function piFailureDiagnostic(failure: PiFailure): string {
  let message = failure.message.slice(0, 300);
  const encode = () => JSON.stringify({ schema: 'pi-error/v1', status: failure.status,
    scope: failure.scope, retryable: failure.retryable, message });
  while (encode().length > 500) message = message.slice(0, Math.max(0, message.length - 16));
  return encode();
}
