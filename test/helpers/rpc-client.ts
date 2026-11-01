import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { FrameReader, frame } from '../../src/rpc/framing.ts';
import { object, valid, LIMITS } from '../../src/rpc/contract.ts';

export class RemoteError extends Error {
  readonly code: number;
  constructor(code: number, message: string) { super(message); this.code = code; }
}
interface Pending { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
/** Internal reference client. No public SDK or editor APIs. */
export class RpcClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly messages: unknown[] = [];
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderr = '';
  private readonly reader = new FrameReader();
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private messageBytes = 0;
  private readonly finished = new Map<string, Record<string, unknown>>();
  private readonly waiting = new Map<string, Pending>();
  constructor(binary: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd: string,
    launcher?: { readonly command: string; readonly args: readonly string[] }) {
    this.child = spawn(launcher?.command ?? process.execPath, launcher === undefined ? [binary, 'rpc', ...args] : [...launcher.args, 'rpc', ...args], { cwd, env, stdio: 'pipe', windowsHide: true });
    this.child.stdout.on('data', (chunk: Buffer) => {
      try {
        for (const body of this.reader.push(chunk)) {
          const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
          for (const message of Array.isArray(value) ? value : [value]) this.message(message);
        }
      } catch { this.fail(new Error('Invalid server response')); this.child.kill(); }
    });
    this.child.stderr.on('data', (bytes: Buffer) => { this.stderr = (this.stderr + bytes.toString()).slice(-65536); });
    this.child.stdin.on('error', () => this.fail(new Error('Server input closed')));
    this.child.on('error', () => this.fail(new Error('Server failed to start')));
    this.exit = new Promise(resolve => this.child.once('close', (code, signal) => {
      this.fail(new Error('Server exited')); resolve({ code, signal });
    }));
  }
  private message(value: unknown): void {
    if (!valid('successResponse', value) && !valid('errorResponse', value) && !valid('serverNotification', value)) throw new Error('Invalid server envelope');
    if (!object(value)) return;
    const bytes = Buffer.byteLength(JSON.stringify(value));
    while (this.messages.length > 0 && (this.messages.length >= 128 || this.messageBytes + bytes > LIMITS.queueBytes)) {
      this.messageBytes -= Buffer.byteLength(JSON.stringify(this.messages.shift()));
    }
    this.messages.push(value); this.messageBytes += bytes;
    if (typeof value.id === 'number') {
      const pending = this.pending.get(value.id);
      if (pending !== undefined) {
        clearTimeout(pending.timer); this.pending.delete(value.id);
        if (object(value.error) && typeof value.error.code === 'number' && typeof value.error.message === 'string') pending.reject(new RemoteError(value.error.code, value.error.message));
        else if (object(value.result)) pending.resolve(value.result);
        else pending.reject(new Error('Missing result'));
      }
    } else if (value.method === 'redline/v1/finished' && object(value.params) && object(value.params.run) && typeof value.params.run.runId === 'string') {
      const run = value.params.run;
      const id = String(run.runId);
      if (this.finished.size >= LIMITS.historyRuns) this.finished.delete(this.finished.keys().next().value ?? '');
      this.finished.set(id, run);
      const pending = this.waiting.get(id);
      if (pending !== undefined) { clearTimeout(pending.timer); this.waiting.delete(id); pending.resolve(run); }
    }
  }
  private fail(error: Error): void {
    for (const map of [this.pending, this.waiting]) {
      for (const pending of map.values()) { clearTimeout(pending.timer); pending.reject(error); }
      map.clear();
    }
  }
  async call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.pending.size >= LIMITS.queueMessages) throw new Error('Too many pending requests');
    const id = this.nextId++;
    const bytes = frame({ jsonrpc: '2.0', id, method: 'redline/v1/' + method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Request deadline')); this.child.kill(); }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(bytes);
    });
  }
  async wait(runId: string): Promise<Record<string, unknown>> {
    const value = this.finished.get(runId);
    if (value !== undefined) return value;
    if (this.waiting.has(runId) || this.waiting.size >= LIMITS.historyRuns) throw new Error('Finished-run wait limit');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(runId); reject(new Error('Review deadline')); this.child.kill(); }, 15_000);
      this.waiting.set(runId, { resolve, reject, timer });
    });
  }
  eof(): void { this.child.stdin.end(); }
  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 1000);
    try { await this.exit; } finally { clearTimeout(timer); }
  }
}
