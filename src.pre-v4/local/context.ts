/** Import bounded context data only. Native harness prompts own indexing and queries. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CapturedRevision } from '../application/review.ts';
import { loadCodeContextArtifact, type CodeContextArtifact } from '../code-context/artifact.ts';
import { loadReviewBundle } from '../review/bundle.ts';
import { codeContextForFile, loadReviewCodeContext, type ReviewCodeContextInput } from '../review/indexed-context.ts';
import type { LocalOptions } from './options.ts';

export interface ImportedLocalContext {
  readonly input: ReviewCodeContextInput;
  readonly fileOnlyReviewedFiles: number;
  readonly indexCache: 'imported' | 'unavailable';
  readonly coverage: Awaited<ReturnType<typeof loadReviewCodeContext>>['coverage'];
}

/** Snapshot a validated import into private output, then resolve every related span from captured head source. */
export async function importLocalContext(capture: CapturedRevision, options: LocalOptions,
  outputDirectory: string, signal: AbortSignal): Promise<ImportedLocalContext> {
  signal.throwIfAborted();
  if (options.indexing.artifact === undefined) throw new Error('context import requires an artifact');
  const repository = options.indexing.repository ?? capture.contextSnapshot?.repository;
  if (repository === undefined) throw new Error('context repository identity is required');
  const bundle = await loadReviewBundle(capture.reviewDirectory, capture.sourceDirectory);
  const directory = join(outputDirectory, 'index');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'code-context.json');
  let artifact: CodeContextArtifact;
  let indexCache: ImportedLocalContext['indexCache'] = 'imported';
  try {
    artifact = await loadCodeContextArtifact(options.indexing.artifact);
    if (artifact.repository !== repository || artifact.revision !== bundle.manifest.head
      || artifact.baseRevision !== undefined && artifact.baseRevision !== bundle.manifest.base) {
      throw new Error('imported context identity mismatch');
    }
  } catch {
    signal.throwIfAborted();
    indexCache = 'unavailable';
    artifact = { version: 2, repository, revision: bundle.manifest.head, baseRevision: bundle.manifest.base,
      provider: { id: options.indexing.provider, version: 'unknown' }, status: 'unavailable', files: [],
      diagnostics: [{ level: 'warning', code: 'imported-context-invalid', message: 'Imported context is invalid or does not match the captured revisions.' }],
      timings: { installationMs: 0, restoreMs: 0, validationMs: 0, indexMs: 0, queryMs: 0, saveMs: null } };
  }
  const credential = options.environment.credential?.value;
  const redact = (text: string): string => credential === undefined ? text : text.split(credential).join('[redacted]');
  artifact = { ...artifact, diagnostics: artifact.diagnostics.map(item => ({ ...item,
    code: redact(item.code) === item.code ? item.code : 'credential-redacted', message: redact(item.message) })) };
  signal.throwIfAborted();
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  const input = { path, repository };
  const loaded = await loadReviewCodeContext(bundle, input);
  signal.throwIfAborted();
  const fileOnlyReviewedFiles = bundle.manifest.files.filter(file => file.reviewed
    && codeContextForFile(loaded, file).coverage.relatedSpans === 0).length;
  await writeFile(join(directory, 'status.json'), `${JSON.stringify({ version: 1, provider: loaded.coverage.provider,
    status: loaded.coverage.status, relatedSpans: loaded.coverage.relatedSpans, fileOnlyReviewedFiles,
    indexCache, diagnosticCodes: loaded.coverage.diagnosticCodes }, null, 2)}\n`, { mode: 0o600 });
  return { input, coverage: loaded.coverage, fileOnlyReviewedFiles, indexCache };
}
