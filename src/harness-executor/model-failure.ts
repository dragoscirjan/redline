/** Classifies runtime error metadata, never model answers or repository content. */
export interface ModelFailureClassification {
  readonly status: number | null;
  readonly scope: 'file' | 'run';
  readonly retryable: boolean;
}

export function percentHexCase(value: string): string {
  return value.replace(/%(?:25)?[0-9a-f]{2}/giu, (escape) => escape.toUpperCase());
}

/** Equal-length normalization permits matching without rewriting unrelated diagnostic text. */
function redactEncoded(message: string, encoded: string): string {
  if (encoded.length > message.length) return message;
  const normalized = percentHexCase(message);
  const needle = percentHexCase(encoded);
  const parts: string[] = [];
  let cursor = 0;
  let index = normalized.indexOf(needle);
  if (index === -1) return message;
  while (index !== -1) {
    parts.push(message.slice(cursor, index), '[redacted]');
    cursor = index + needle.length;
    index = normalized.indexOf(needle, cursor);
  }
  parts.push(message.slice(cursor));
  return parts.join('');
}

/** The same finite forms are used by whole-text and streaming redaction. */
export function credentialTextForms(credential: string): ReadonlyMap<string, boolean> {
  const forms = new Map([[credential, false], [JSON.stringify(credential).slice(1, -1), false]]);
  let layer = [credential];
  // At most twelve encoded forms across two URI/strict-URI/form layers. Never recursively
  // decode untrusted messages or build a regular expression from a secret.
  for (let depth = 0; depth < 2; depth += 1) {
    const next = new Set<string>();
    for (const value of layer) {
      try {
        const component = encodeURIComponent(value);
        const strict = component.replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
        for (const encoded of [component, strict, new URLSearchParams({ key: value }).toString().slice(4)]) {
          next.add(encoded);
          if (!forms.has(encoded)) forms.set(encoded, true);
        }
      } catch { /* Malformed Unicode retains literal and JSON-escaped redaction. */ }
    }
    layer = [...next];
  }
  return forms;
}

/** Redact literal and encoded credentials without changing authoritative source whitespace. */
export function redactCredentialText(message: string, credential?: string): string {
  if (credential !== undefined && credential.length > 0) {
    for (const [value, encoded] of [...credentialTextForms(credential)].sort(([a], [b]) => b.length - a.length)) {
      message = encoded ? redactEncoded(message, value) : message.split(value).join('[redacted]');
    }
  }
  return message;
}

export function redactModelFailure(message: string, credential?: string): string {
  return redactCredentialText(message, credential).replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').replace(/\s+/gu, ' ').trim();
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
