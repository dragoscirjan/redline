/** Classifies runtime error metadata, never model answers or repository content. */
export interface ModelFailureClassification {
  readonly status: number | null;
  readonly scope: 'file' | 'run';
  readonly retryable: boolean;
}

export function redactModelFailure(message: string, credential?: string): string {
  if (credential !== undefined && credential.length > 0) {
    const forms = new Set([credential, JSON.stringify(credential).slice(1, -1)]);
    try { forms.add(encodeURIComponent(credential)); } catch { /* Malformed Unicode has no URI encoding. */ }
    for (const value of [...forms].sort((a, b) => b.length - a.length)) message = message.split(value).join('[redacted]');
  }
  return message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

export function classifyModelFailure(message: string, callerManaged = false): ModelFailureClassification {
  const match = /^(?:Error:\s*)?([45][0-9]{2})\b/iu.exec(message)
    ?? /\b(?:HTTP(?: error)?|APIError|(?:status|error)(?: code)?)[\s:=]+([45][0-9]{2})\b/iu.exec(message);
  const status = match === null ? null : Number(match[1]);
  const parameterFailure = /reasoning is mandatory.{0,120}cannot be disabled|invalid (?:json )?schema|unsupported (?:request )?parameter|unknown parameter|(?:response_format|json_schema).{0,60}(?:unsupported|not supported|invalid|must be)|(?:does not support|unsupported).{0,60}(?:response_format|json_schema|reasoning)/iu.test(message);
  const authenticationFailure = /invalid.{0,20}api.?key|no api key found|authentication failed|account.{0,20}(?:disabled|suspended)/iu.test(message);
  const shared = status === 401 || status === 402 || status === 404
    || (status === 403 && authenticationFailure)
    || ((status === null || status === 400 || status === 422) && parameterFailure)
    || (status === null && authenticationFailure);
  const upstreamRuntimeError = callerManaged && status === null
    && /^Upstream error from [^:\r\n]{1,160}:\s*(?:Internal server error|Service unavailable|Bad gateway|Gateway timeout|Server overloaded)\b/iu.test(message);
  const retryable = !shared && ((status !== null && [429, 500, 502, 503, 504].includes(status))
    || (status === null && /\bECONNRESET\b|\bETIMEDOUT\b|fetch failed|socket hang up/iu.test(message))
    || upstreamRuntimeError);
  return { status, scope: shared ? 'run' : 'file', retryable };
}
