import { createHash } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import {
  nodeProcessSpawner,
  runBoundedProcess,
  type BoundedRunResult,
} from '../process-runner.js';
import type { ContentDigest } from './types.js';

export interface ToolCommandRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
}

export interface ToolCommandRunner {
  run(request: ToolCommandRequest): Promise<BoundedRunResult>;
}

export const nodeToolCommandRunner: ToolCommandRunner = {
  run: (request) => runBoundedProcess(nodeProcessSpawner, request),
};

export interface ToolDownloadRequest {
  readonly url: string;
  readonly destination: string;
  readonly timeoutMs: number;
  readonly maximumBytes: number;
}

export interface ToolDownloader {
  download(request: ToolDownloadRequest): Promise<void>;
}

/** Public HTTPS downloader with bounded bytes, timeout, and atomic caller-owned destination creation. */
export class FetchToolDownloader implements ToolDownloader {
  async download(request: ToolDownloadRequest): Promise<void> {
    const requestedUrl = new URL(request.url);
    if (requestedUrl.protocol !== 'https:') throw new Error('tool downloads require HTTPS');
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
      throw new Error('tool download timeout must be a positive safe integer');
    }
    if (!Number.isSafeInteger(request.maximumBytes) || request.maximumBytes <= 0) {
      throw new Error('tool download byte limit must be a positive safe integer');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    let handle;
    let createdDestination = false;
    try {
      handle = await open(request.destination, 'wx', 0o600);
      createdDestination = true;
      const response = await fetch(requestedUrl, { signal: controller.signal });
      if (!response.ok || response.body === null) {
        throw new Error(`tool download returned HTTP ${response.status}`);
      }
      if (new URL(response.url).protocol !== 'https:') throw new Error('tool download redirected outside HTTPS');
      const declaredLength = response.headers.get('content-length');
      if (declaredLength !== null) {
        const bytes = Number(declaredLength);
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > request.maximumBytes) {
          throw new Error('tool download exceeds its byte limit');
        }
      }
      const reader = response.body.getReader();
      let received = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += chunk.value.byteLength;
        if (received > request.maximumBytes) {
          await reader.cancel();
          throw new Error('tool download exceeds its byte limit');
        }
        await handle.write(Buffer.from(chunk.value));
      }
      await handle.sync();
    } catch (error) {
      if (handle !== undefined) {
        try {
          await handle.close();
        } catch {
          // Preserve the download failure; cleanup below remains best effort.
        } finally {
          handle = undefined;
        }
      }
      if (createdDestination) {
        try {
          await rm(request.destination, { force: true });
        } catch {
          // Preserve the bounded download failure.
        }
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (handle !== undefined) await handle.close();
    }
  }
}

export async function assertFileContentDigest(path: string, expected: ContentDigest): Promise<void> {
  const separator = expected.indexOf(':');
  const algorithm = expected.slice(0, separator);
  const expectedHex = expected.slice(separator + 1);
  const handle = await open(path, 'r');
  const hash = createHash(algorithm);
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  if (hash.digest('hex') !== expectedHex) throw new Error('downloaded tool digest does not match its descriptor');
}
