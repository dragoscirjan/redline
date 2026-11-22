# Capture a Git change

Use the revision-source adapter to build a review context bundle without executing reviewed code or modifying the source repository. This is a developer module API in the current checkout, not a published command or stable package export.

## Prerequisites and privacy

Use the pinned tools and installed dependencies in an approved Redline worktree. The source repository must be a non-bare Git worktree with the requested commits available locally. No model credentials, MCP server or network access are needed.

Choose an absolute output path outside the source repository. Its parent must already exist; the destination itself must not exist. Capture creates it privately and refuses existing destinations. Captured files can contain repository secrets. Treat the bundle as sensitive and do not publish it merely because capture passed.

## Call the adapter

The following module example is intended to run from the Redline worktree root using Node 24 or Bun. Replace the repository and output paths. `HEAD~1` and `HEAD` are example revision choices, not application defaults. They require at least two locally available commits.

```js
import { GitRevisionSource } from './src/revision-source/git.ts';

const source = new GitRevisionSource({
  repository: '/absolute/path/to/repository',
  base: 'HEAD~1',
  target: { kind: 'revision', head: 'HEAD', comparison: 'direct' },
  outputDirectory: '/absolute/path/to/existing-parent/new-capture',
}, process.env);

const captured = await source.capture(AbortSignal.timeout(30_000));
try {
  console.log(captured.reviewDirectory);
  console.log(captured.sourceDirectory);
  console.log(captured.coverage);
} finally {
  await captured.dispose();
}
```

The example applies a caller deadline of 30 seconds. Successful capture returns artifact locations and explicit coverage. `dispose()` removes owned scratch Git metadata; successful artifacts remain at the selected destination. On failure or cancellation, the adapter removes its own partial output and scratch data. It does not remove pre-existing destinations.

Only PATH and the Windows system-root setting are retained from the supplied host environment. Repository-local executable paths, global Git configuration, credential helpers, executable filters and hooks are not used for capture. Git is selected outside the canonical worktree boundary. Source snapshots do not materialize symlinks or submodules.

## Select working-tree changes

For tracked changes against the current commit, replace the selection fields with:

```js
base: 'HEAD',
target: { kind: 'worktree', mode: 'all', untracked: false },
```

- `staged` captures the index.
- `unstaged` compares the working tree with a captured index baseline.
- `all` captures staged and unstaged contents against the selected base.
- `untracked: true` explicitly includes eligible untracked paths in `unstaged` or `all` mode. Combining it with `staged` fails instead of silently dropping the request.

Concurrent changes to captured working files, index bytes or HEAD cause failure when consistency cannot be established. Committed captures resolve their selected revisions to immutable object IDs in isolated scratch metadata. Shallow-history boundaries are preserved; missing history fails rather than triggering a fetch.

## Inspect artifacts

| Path | Contents |
| --- | --- |
| `capture.json` | Requested/resolved identities, selection, index digest when applicable, inert links and coverage. |
| `source/` | Bounded regular-file contents at captured head. No linked targets or submodule contents. |
| `bundle/manifest.json` | Authoritative changed-file list, diff/base references and deterministic review eligibility. |
| `bundle/diffs/` | Per-file authoritative patches. |
| `bundle/base-files/` | Captured base content where required. |
| `bundle/raw/`, `bundle/commits/` | Bounded Git change and history records. |

Eligibility uses built-in exclusions plus any valid `.redline/review-eligibility.json` from the trusted committed base. Head or working-tree policy edits cannot change their own eligibility. Binary files, lock files and generated/vendor directories are excluded deterministically. The scratch index is cleared before bundle generation so captured working-tree attributes do not become a classification policy. Required base blobs must be captured successfully; cancellation, timeouts and byte-limit failures are not converted into missing base files. Gitlink base entries remain inert rather than being treated as source blobs.

The bundle is context, not a review result. No findings, clean-review verdict or publication object is produced.

## Bounds and failure behavior

Capture allows at most 20,000 source files, changed files or refs. The changed-file bound includes deletions and is checked before per-file artifacts are requested. Working files and raw index input each have a 16 MiB limit. The index is hashed in bounded chunks with cancellation and regular-file checks, not retained as an unbounded buffer. Captured-source/bundle byte budgets remain 256 MiB each, with 16 MiB of stdout per Git command. Each Git command has a 30-second ceiling; the caller's AbortSignal bounds the full operation. Regular source files over 128 KiB are omitted from the materialized snapshot and counted in coverage rather than silently presented as complete.

Invalid revisions, unsupported index states, unsafe paths, existing output, exceeded limits and detected concurrent changes fail explicitly. Diagnostics from Git stderr are not returned because they may contain sensitive input. An error does not imply a clean change.

## Verify the implementation

```sh
mise run validate
```

The active suite includes real revision/worktree fixtures, installed Node/Bun capture, archive exclusion and a readiness-synchronized POSIX process-cancellation test. Windows-specific process cleanup, live model behavior, review quality and Docker execution are not established by those checks.
