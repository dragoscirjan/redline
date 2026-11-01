import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const pins = JSON.parse(await readFile('/build/pins.json', 'utf8'));
const response = await fetch(pins.pnpm.url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
if (!response.ok) throw new Error('Pinned pnpm download failed');
const parts = []; let total = 0;
for await (const part of response.body) {
  total += part.length;
  if (total > 64 * 1024 * 1024) throw new Error('Pinned pnpm archive exceeds limit');
  parts.push(part);
}
const bytes = Buffer.concat(parts);
if ('sha512-' + createHash('sha512').update(bytes).digest('base64') !== pins.pnpm.integrity) throw new Error('Pinned pnpm integrity mismatch');
await writeFile('/tmp/pnpm.tgz', bytes, { mode: 0o600 });
await mkdir('/opt/pnpm', { recursive: true });
execFileSync('tar', ['-xzf', '/tmp/pnpm.tgz', '--strip-components=1', '-C', '/opt/pnpm']);
await rm('/tmp/pnpm.tgz');
