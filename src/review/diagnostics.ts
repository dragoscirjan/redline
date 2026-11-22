import { Effect } from 'effect';
import type { CapturedRevision } from '../revision-source/types.ts';

export type DiagnosticArtifact = unknown;
export type ImportedDiagnostics = unknown;

export class DiagnosticImporter {
  importSarif(artifact: DiagnosticArtifact, capture: CapturedRevision): Effect.Effect<ImportedDiagnostics, Error> {
    // Ingest a bounded pre-produced CI artifact and re-resolve evidence against captured source; never execute scanners or PR builds.
    return Effect.fail(new Error('Not implemented: DiagnosticImporter.importSarif'));
  }
}
