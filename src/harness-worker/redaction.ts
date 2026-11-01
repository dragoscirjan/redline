import { credentialTextForms, percentHexCase } from '../harness-executor/model-failure.ts';

/** Retain enough lookahead to redact credentials even across HTTP and UTF-8 chunk boundaries. */
export class CredentialStream {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private readonly forms: readonly { value: string; encoded: boolean }[];
  private readonly lookahead: number;
  private pending = '';
  constructor(credential?: string) {
    this.forms = credential === undefined || credential.length === 0 ? []
      : [...credentialTextForms(credential)].map(([value, encoded]) => ({ value, encoded })).sort((a, b) => b.value.length - a.value.length);
    this.lookahead = Math.max(1, ...this.forms.map(f => f.value.length));
  }
  push(bytes: Uint8Array, final = false): Buffer {
    const text = this.pending + this.decoder.decode(bytes, { stream: !final });
    const normalized = percentHexCase(text);
    const stop = final ? text.length : Math.max(0, text.length - this.lookahead + 1);
    const output: string[] = [];
    let cursor = 0;
    while (cursor < stop) {
      let start = text.length;
      let length = 0;
      for (const form of this.forms) {
        const index = (form.encoded ? normalized : text).indexOf(form.encoded ? percentHexCase(form.value) : form.value, cursor);
        if (index !== -1 && (index < start || (index === start && form.value.length > length))) {
          start = index; length = form.value.length;
        }
      }
      if (start < stop) {
        output.push(text.slice(cursor, start), '[redacted]');
        cursor = start + length;
      } else {
        let end = stop;
        if (!final && end > cursor && /[\uD800-\uDBFF]/u.test(text[end - 1] ?? '')) end--;
        output.push(text.slice(cursor, end)); cursor = end;
        break;
      }
    }
    this.pending = text.slice(cursor);
    return Buffer.from(output.join(''));
  }
}
