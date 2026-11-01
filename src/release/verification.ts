import { join } from 'node:path';
import { DockerClient } from '../harness-worker/docker-client.ts';
import type { WorkerImage } from '../harness-worker/images.ts';
import { executable } from '../local/process.ts';
import type { ReleaseRecord } from './coordinator.ts';

/** An empty private Docker config forces anonymous pulls, even when the daemon has cached layers. */
export async function pullPublicImages(record: ReleaseRecord, state: string): Promise<void> {
  const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : undefined;
  if (process.platform !== 'linux' || arch === undefined) throw new Error('Native Linux image verification required');
  const command = await executable('docker', process.env.PATH ?? '', process.cwd());
  const client = await DockerClient.create(command, process.cwd(), join(state, 'docker-state'), { PATH: process.env.PATH, HOME: state, LANG: 'C.UTF-8' });
  try {
    for (const h of ['pi', 'opencode'] as const) {
      const entry = record.images[h];
      const image: WorkerImage = { reference: `ghcr.io/${entry.repository}@${entry.digest}`, platforms: ['linux/amd64', 'linux/arm64'], development: false,
        identity: { harness: h, release: record.release, revision: record.source, harnessVersion: entry.harnessVersion } };
      const signal = AbortSignal.timeout(180_000);
      await client.run(['pull', '--platform', 'linux/' + arch, image.reference], signal, 180_000, 1024 * 1024);
      await client.preflight(image, signal);
      const config = await client.run(['image', 'inspect', image.reference, '--format', '{{.Id}}'], signal);
      if (config !== entry.platforms.find(p => p.architecture === arch)?.config) throw new Error('Public image does not match the executed native candidate');
    }
  } finally { await client.close(); }
}
