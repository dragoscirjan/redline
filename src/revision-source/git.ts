/** Git object adapter. Scratch metadata never reads repository config or attributes. */
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { buildBundle, MAX_CAPTURE_FILES, type BundleGit } from '../context-bundle.ts';
import type { CaptureRequest, CapturedRevision, RevisionSource } from './types.ts';
import { executable, GitCommand, gitEnvironment, inside, LocalOperationError, repositoryBoundary } from './process.ts';

const MAX_FILES = MAX_CAPTURE_FILES;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const decode = new TextDecoder('utf-8', { fatal: true });
const digest = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
interface Entry { readonly mode: string; readonly oid: string; readonly path: string }

/** Git terminates path output with a newline; other whitespace belongs to the path. */
function gitPath(raw: Buffer): string {
  const value = decode.decode(raw);
  if (!value.endsWith('\n')) throw new LocalOperationError('Git returned an unterminated path');
  const ending = process.platform === 'win32' && value.endsWith('\r\n') ? 2 : 1;
  return value.slice(0, -ending);
}

/** Hash raw index bytes without following links or retaining unbounded index extensions. */
async function indexDigest(path: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw new LocalOperationError('Git index is unsafe or unreadable');
  });
  if (handle === undefined) return digest(Buffer.alloc(0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new LocalOperationError('Git index must be a regular file');
    if (before.size > MAX_FILE_BYTES) throw new LocalOperationError('Git index exceeds its byte limit');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let bytes = 0;
    while (true) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, MAX_FILE_BYTES + 1 - bytes), null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > MAX_FILE_BYTES) throw new LocalOperationError('Git index exceeds its byte limit');
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    signal.throwIfAborted();
    if (bytes !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new LocalOperationError('Git index changed during capture');
    }
    return hash.digest('hex');
  } finally { await handle.close(); }
}

function entries(raw: Buffer, index: boolean): Entry[] {
  const values = decode.decode(raw).split('\0').filter(Boolean);
  if (values.length > MAX_FILES) throw new LocalOperationError('Git capture exceeded its file count limit');
  return values.map((value) => {
    const match = (index ? /^(\d{6}) ([0-9a-f]{40,64}) (\d)\t(.+)$/su : /^(\d{6}) (?:blob|commit) ([0-9a-f]{40,64})\t(.+)$/su).exec(value);
    if (match === null || (index && match[3] !== '0')) throw new LocalOperationError('unmerged or unsupported Git index/tree');
    const path = match[index ? 4 : 3]!;
    if (isAbsolute(path) || path.split('/').some((part) => part === '..' || part.toLowerCase() === '.git') || path.includes('\\')) {
      throw new LocalOperationError('unsafe Git capture path');
    }
    return { mode: match[1]!, oid: match[2]!, path };
  });
}

async function fileBytes(root: string, path: string): Promise<{ data: Buffer; mode: string } | null> {
  const full = resolve(root, path);
  if (!inside(root, full)) throw new LocalOperationError('source path escaped repository');
  // Do not follow directory symlinks or final-component symlinks into source data.
  const parent = await realpath(dirname(full)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (parent === undefined) return null;
  if (!inside(root, parent) || parent !== dirname(full)) throw new LocalOperationError('source directory symlink is not traversable');
  const info = await lstat(full).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (info === undefined) return null;
  if (info.isSymbolicLink()) return { data: Buffer.from(await readlink(full)), mode: '120000' };
  if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new LocalOperationError('unsupported or oversized working-tree file');
  const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_FILE_BYTES) throw new LocalOperationError('source changed during capture');
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_FILE_BYTES + 1 - bytes));
      const { bytesRead } = await handle.read(buffer);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > MAX_FILE_BYTES) throw new LocalOperationError('working-tree file exceeded its byte limit');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const data = Buffer.concat(chunks);
    const after = await handle.stat();
    if (data.length > MAX_FILE_BYTES || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || before.ino !== info.ino || await realpath(dirname(full)) !== parent) throw new LocalOperationError('source changed during capture');
    return { data, mode: (before.mode & 0o111) === 0 ? '100644' : '100755' };
  } finally { await handle.close(); }
}

/** Shallow grafts are history data, not repository configuration. Copy only bounded commit IDs. */
async function shallowBoundary(git: GitCommand, root: string, oidLength: number): Promise<Buffer | undefined> {
  const path = resolve(root, gitPath(await git.run(['rev-parse', '--git-path', 'shallow'])));
  const maximumBytes = MAX_FILES * (oidLength + 2);
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (info === undefined) return undefined;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maximumBytes) {
    throw new LocalOperationError('unsafe or oversized Git shallow boundary');
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maximumBytes
      || before.ino !== info.ino || before.dev !== info.dev) throw new LocalOperationError('Git shallow boundary changed during capture');
    const buffer = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (length > maximumBytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new LocalOperationError('Git shallow boundary changed or exceeded its byte limit');
    }
    const data = buffer.subarray(0, length);
    const lines = data.toString('utf8').split('\n');
    if (lines.at(-1) === '') lines.pop();
    const oid = new RegExp('^[0-9a-f]{' + oidLength + '}$', 'u');
    if (lines.length > MAX_FILES || lines.some((line) => !oid.test(line.replace(/\r$/u, '')))) {
      throw new LocalOperationError('invalid Git shallow boundary');
    }
    return data;
  } finally { await handle.close(); }
}

export class GitRevisionSource implements RevisionSource {
  private readonly options: CaptureRequest;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly output: string;
  constructor(options: CaptureRequest, environment: NodeJS.ProcessEnv) {
    this.options = { ...options, target: { ...options.target } };
    this.environment = { PATH: environment.PATH, SystemRoot: environment.SystemRoot ?? environment.SYSTEMROOT };
    this.output = options.outputDirectory;
  }
  /** Capture the selected Git or worktree state without repository hooks or filters, rejecting mixed snapshots and honoring cancellation. */
  async capture(signal: AbortSignal): Promise<CapturedRevision> {
    const { options, output } = this;
    signal.throwIfAborted();
    if (options.target.kind === 'worktree' && options.target.mode === 'staged' && options.target.untracked) {
      throw new LocalOperationError('untracked files cannot be included in a staged-only capture');
    }
    const directory = await realpath(options.repository);
    const boundary = await repositoryBoundary(directory);
    const command = await executable('git', this.environment.PATH ?? '', boundary);
    const env = gitEnvironment(command, this.environment);
    let original = new GitCommand(command, directory, env, signal);
    const root = await realpath(gitPath(await original.run(['rev-parse', '--show-toplevel'])));
    original = new GitCommand(command, root, env, signal);
    const originalHead = decode.decode(await original.run(['rev-parse', '--verify', 'HEAD'])).trim();
    const refs = decode.decode(await original.run(['for-each-ref', '--format=%(objectname) %(refname)'])).trim().split('\n').filter(Boolean);
    if (refs.length > MAX_FILES || refs.some((ref) => !/^[0-9a-f]{40,64} refs\/[^\s]+$/u.test(ref))) {
      throw new LocalOperationError('unsupported or excessive Git refs');
    }
    const objectPath = await realpath(resolve(root, gitPath(await original.run(['rev-parse', '--git-path', 'objects']))));
    if (/[\r\n]/u.test(objectPath)) throw new LocalOperationError('unsupported object-directory path');
    const scratch = await mkdtemp(join(tmpdir(), 'redline-git-'));
    let ownsOutput = false;
    try {
      if (!isAbsolute(output)) throw new LocalOperationError('capture output must be an absolute path');
      const outputParent = await realpath(dirname(output));
      if (inside(root, join(outputParent, basename(output)))) {
        throw new LocalOperationError('capture output must be outside the reviewed repository');
      }
      try { await mkdir(output, { mode: 0o700 }); }
      catch { throw new LocalOperationError('capture output must not already exist and must have an accessible parent'); }
      ownsOutput = true;
      const git = new GitCommand(command, scratch, env, signal);
      const format = decode.decode(await original.run(['rev-parse', '--show-object-format'])).trim();
      if (format !== 'sha1' && format !== 'sha256') throw new LocalOperationError('unsupported Git object format');
      await git.run(['init', '--quiet', `--object-format=${format}`, '--template=']);
      await git.run(['config', 'core.abbrev', format === 'sha1' ? '40' : '64']);
      const shallow = await shallowBoundary(original, root, format === 'sha1' ? 40 : 64);
      if (shallow !== undefined) await writeFile(join(scratch, '.git/shallow'), shallow, { flag: 'wx', mode: 0o600 });
      await writeFile(join(scratch, '.git/objects/info/alternates'), `${objectPath}\n`);
      if (refs.length > 0) await git.run(['update-ref', '--stdin'], Buffer.from(refs.map((ref) => {
        const [oid, name] = ref.split(' ');
        return `update ${name} ${oid}\n`;
      }).join('')));
      await git.run(['update-ref', '--no-deref', 'HEAD', originalHead]);
      // Revision expressions and object reads happen only in metadata with no
      // remotes, promisor configuration, hooks, or executable filter drivers.
      const resolveCommit = async (ref: string): Promise<string> => {
        if (ref.length > 1024 || /\p{Cc}/u.test(ref)) throw new LocalOperationError('invalid revision');
        return decode.decode(await git.run(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim();
      };
      const requestedBase = await resolveCommit(options.base);
      const requestedHead = await resolveCommit(options.target.kind === 'revision' ? options.target.head : 'HEAD');
      let base = requestedBase;
      let head = requestedHead;
      let ignoredUntracked: string[] = [];
      let capturedIndex: string | undefined;
      if (options.target.kind === 'revision' && options.target.comparison === 'merge-base') {
        const bases = decode.decode(await git.run(['merge-base', '--all', requestedBase, requestedHead])).trim().split('\n');
        if (bases.length !== 1) throw new LocalOperationError('comparison has multiple merge bases; select --comparison direct');
        base = bases[0]!;
      } else if (options.target.kind === 'worktree') {
        const target = options.target;
        const indexFile = resolve(root, gitPath(await original.run(['rev-parse', '--git-path', 'index'])));
        capturedIndex = await indexDigest(indexFile, signal);
        const debug = (await original.run(['ls-files', '--debug'])).toString('utf8');
        if ([...debug.matchAll(/flags: ([0-9a-f]+)/gu)].some((match) => (Number.parseInt(match[1]!, 16) & 0x60000000) !== 0)) {
          throw new LocalOperationError('intent-to-add and sparse indexes require staging/materialization before review');
        }
        const indexBefore = await original.run(['ls-files', '--stage', '-z']);
        const indexEntries = entries(indexBefore, true);
        const indexedModes = new Map(indexEntries.map((entry) => [entry.path, entry.mode]));
        // Rebuild the index from object IDs: no copied index extensions, hooks, filters, or fsmonitor state.
        await git.run(['read-tree', '--empty']);
        await git.run(['update-index', '-z', '--index-info'], indexBefore);
        const indexTree = decode.decode(await git.run(['write-tree'])).trim();
        const commit = async (tree: string, parent: string): Promise<string> => decode.decode(await git.run(
          ['commit-tree', tree, '-p', parent], Buffer.from('Redline captured state\n'), {
            GIT_AUTHOR_NAME: 'Redline', GIT_AUTHOR_EMAIL: 'redline@localhost', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
            GIT_COMMITTER_NAME: 'Redline', GIT_COMMITTER_EMAIL: 'redline@localhost', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
          },
        )).trim();
        if (target.mode === 'unstaged') base = await commit(indexTree, requestedBase);
        if (target.mode === 'staged') head = await commit(indexTree, base);
        else {
          const untrackedBefore = await original.run(['ls-files', '--others', '--exclude-standard', '-z']);
          const untracked = decode.decode(untrackedBefore).split('\0').filter(Boolean);
          if (untracked.length > MAX_FILES) throw new LocalOperationError('untracked file selection exceeded its count limit');
          ignoredUntracked = target.untracked ? [] : untracked;
          const paths = [...indexEntries.filter((entry) => entry.mode !== '160000').map((entry) => entry.path), ...(target.untracked ? untracked : [])];
          if (paths.length > MAX_FILES) throw new LocalOperationError('working-tree capture exceeded its file count limit');
          const fingerprints = new Map<string, string>();
          let bytes = 0;
          for (const path of paths) {
            signal.throwIfAborted();
            const captured = await fileBytes(root, path);
            fingerprints.set(path, captured === null ? 'absent' : `${captured.mode}:${digest(captured.data)}`);
            if (captured === null) await git.run(['update-index', '--force-remove', '--', path]);
            else {
              bytes += captured.data.length;
              if (bytes > MAX_TOTAL_BYTES) throw new LocalOperationError('working-tree capture exceeded its total byte limit');
              const oid = decode.decode(await git.run(['hash-object', '-w', '--stdin'], captured.data)).trim();
              // Windows working-file permissions do not encode Git executable modes.
              const mode = process.platform === 'win32' && captured.mode !== '120000'
                ? indexedModes.get(path) ?? captured.mode : captured.mode;
              await git.run(['update-index', '--add', '--cacheinfo', mode, oid, path]);
            }
          }
          const tree = decode.decode(await git.run(['write-tree'])).trim();
          head = await commit(tree, base);
          // Read bytes again, not just timestamps: concurrent same-size writes must not pass.
          for (const [path, fingerprint] of fingerprints) {
            const current = await fileBytes(root, path);
            if ((current === null ? 'absent' : `${current.mode}:${digest(current.data)}`) !== fingerprint) {
              throw new LocalOperationError('working tree changed during capture; retry after writes stop');
            }
          }
          if (!(await original.run(['ls-files', '--others', '--exclude-standard', '-z'])).equals(untrackedBefore)) {
            throw new LocalOperationError('untracked file selection changed during capture');
          }
        }
        const indexAfter = await indexDigest(indexFile, signal);
        if (indexAfter !== capturedIndex || !(await original.run(['ls-files', '--stage', '-z'])).equals(indexBefore)
          || decode.decode(await original.run(['rev-parse', '--verify', 'HEAD'])).trim() !== originalHead) throw new LocalOperationError('Git index or HEAD changed during capture');
      }
      // Bundle classification must not inherit attributes from the captured working index.
      await git.run(['read-tree', '--empty']);
      const bundleDirectory = join(output, 'bundle');
      const sourceDirectory = join(output, 'source');
      const exportSnapshot = async (revision: string, directory: string) => {
        await mkdir(directory, { recursive: true });
        let writtenBytes = 0;
        let omittedSourceFiles = 0;
        let inertSubmodules = 0;
        const links: { path: string; target: string }[] = [];
        for (const entry of entries(await git.run(['ls-tree', '-r', '-z', revision]), false)) {
          if (entry.mode === '160000') { inertSubmodules += 1; continue; }
          const size = Number(decode.decode(await git.run(['cat-file', '-s', entry.oid])).trim());
          if (!Number.isSafeInteger(size) || size > 128 * 1024) { omittedSourceFiles += 1; continue; }
          const data = await git.run(['cat-file', 'blob', entry.oid]);
          writtenBytes += data.length;
          if (writtenBytes > MAX_TOTAL_BYTES) throw new LocalOperationError('captured source exceeded its total byte limit');
          if (entry.mode === '120000') { links.push({ path: entry.path, target: decode.decode(data) }); continue; }
          const destination = join(directory, entry.path);
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, data, { flag: 'wx' });
        }
        return { omittedSourceFiles, inertSubmodules, links };
      };
      const { omittedSourceFiles, inertSubmodules, links } = await exportSnapshot(head, sourceDirectory);
      let bundleBytes = 0;
      const commands: BundleGit = {
        run: (args) => git.run(args),
        write: async (args, destination) => {
          const data = await git.run(args);
          bundleBytes += data.length;
          if (bundleBytes > MAX_TOTAL_BYTES) throw new LocalOperationError('bundle exceeded its total byte limit');
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, data);
        },
      };
      await buildBundle({ base, head, output: bundleDirectory, eligibilityPolicyFile: null,
        policyBase: options.target.kind === 'worktree' ? requestedBase : base }, commands);
      const currentShallow = await shallowBoundary(original, root, format === 'sha1' ? 40 : 64);
      if (shallow === undefined ? currentShallow !== undefined : currentShallow === undefined || !shallow.equals(currentShallow)) {
        throw new LocalOperationError('Git shallow boundary changed during capture');
      }
      const commonDirectory = await realpath(resolve(root, gitPath(await original.run(['rev-parse', '--git-common-dir']))));
      const repositoryIdentity = `local/${digest(Buffer.from(commonDirectory))}`;
      const coverage = { excludedUntrackedFiles: ignoredUntracked.length, omittedSourceFiles, inertSymlinks: links.length, inertSubmodules };
      await writeFile(join(output, 'capture.json'), `${JSON.stringify({
        version: 1, vcs: 'git', repositoryIdentity, requestedBase, requestedHead, base, head, target: options.target,
        ...(capturedIndex === undefined ? {} : { indexDigest: capturedIndex }), excludedUntracked: ignoredUntracked,
        symlinks: links, coverage,
      }, null, 2)}\n`);
      return {
        reviewDirectory: bundleDirectory, sourceDirectory, repositoryDirectory: root, coverage,
        contextSnapshot: {
          repository: repositoryIdentity, base, head,
        },
        dispose: () => rm(scratch, { recursive: true, force: true }),
      };
    } catch (error) {
      await rm(scratch, { recursive: true, force: true });
      if (ownsOutput) await rm(output, { recursive: true, force: true });
      throw error;
    }
  }
}
