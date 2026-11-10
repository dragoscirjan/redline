/** Private repository-scoped result state. Failure disables reuse, never review. */
import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { CapturedRevision } from '../application/review.ts';
import type { ReviewReuseEnvironment } from '../review/environment.ts';
import type { LocalOptions } from './options.ts';
import { inside } from './process.ts';

export async function localReviewReuse(capture: CapturedRevision, options: LocalOptions): Promise<ReviewReuseEnvironment | undefined> {
  if (options.reuse === 'disabled' || capture.contextSnapshot === undefined) return undefined;
  try {
    const missing: string[] = [];
    let nearest = dirname(options.stateDirectory);
    while (await lstat(nearest).then(() => false, (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return true;
    })) {
      missing.push(basename(nearest)); nearest = dirname(nearest);
    }
    let anchor = await realpath(nearest);
    if (inside(options.repository, anchor)) return undefined;
    const anchorInfo = await lstat(anchor);
    if (!anchorInfo.isDirectory() || (process.platform !== 'win32' && (anchorInfo.mode & 0o022) !== 0)) return undefined;
    for (const name of missing.reverse()) {
      anchor = join(anchor, name);
      await mkdir(anchor, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
      const info = await lstat(anchor);
      if (!info.isDirectory() || info.isSymbolicLink()) return undefined;
    }
    const namespace = capture.contextSnapshot.repository;
    const key = createHash('sha256').update(namespace).digest('hex');
    let directory = anchor;
    for (const name of ['results', 'v1', key, 'entries']) {
      directory = join(directory, name);
      await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()
        || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) return undefined;
    }
    return { directory: dirname(directory), namespace };
  } catch { return undefined; }
}
