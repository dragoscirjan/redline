import type {
  CodeIntelligenceProvider,
  CodeIntelligenceProviderDescriptor,
  CodeIntelligenceQuery,
  CodeIntelligenceQueryResult,
  CodeIntelligenceRecording,
  SnapshotBuildRequest,
  SnapshotOpenRequest,
  SnapshotOperationResult,
} from '../../src/code-intelligence/types.js';

function identityMatches(
  recording: CodeIntelligenceRecording,
  request: Pick<SnapshotBuildRequest, 'repositoryId' | 'revision' | 'sourceTreeDigest' | 'configurationDigest'>,
): boolean {
  const snapshot = recording.snapshot;
  return request.repositoryId === snapshot.repositoryId
    && request.revision === snapshot.revision
    && request.sourceTreeDigest === snapshot.sourceTreeDigest
    && request.configurationDigest === snapshot.configurationDigest;
}

/** Offline provider used to exercise one adapter recording against the common contract. */
export class RecordedCodeIntelligenceProvider implements CodeIntelligenceProvider {
  readonly id: string;
  readonly #recording: CodeIntelligenceRecording;
  #closed = false;

  constructor(recording: CodeIntelligenceRecording) {
    this.id = recording.descriptor.id;
    this.#recording = recording;
  }

  async describe(): Promise<CodeIntelligenceProviderDescriptor> {
    this.#assertOpen();
    return this.#recording.descriptor;
  }

  async buildSnapshot(request: SnapshotBuildRequest): Promise<SnapshotOperationResult> {
    this.#assertOpen();
    if (!identityMatches(this.#recording, request)) {
      return {
        status: 'failed',
        diagnostics: [{
          level: 'error',
          code: 'identity-mismatch',
          message: 'The recorded snapshot does not match the requested immutable source identity.',
        }],
        durationMs: 0,
      };
    }
    return { status: 'succeeded', snapshot: this.#recording.snapshot, diagnostics: [], durationMs: 1 };
  }

  async openSnapshot(request: SnapshotOpenRequest): Promise<SnapshotOperationResult> {
    this.#assertOpen();
    if (request.snapshotId !== this.#recording.snapshot.id || !identityMatches(this.#recording, request)) {
      return {
        status: 'failed',
        diagnostics: [{
          level: 'error',
          code: 'identity-mismatch',
          message: 'The recorded snapshot cannot be opened under a different immutable identity.',
        }],
        durationMs: 0,
      };
    }
    return { status: 'succeeded', snapshot: this.#recording.snapshot, diagnostics: [], durationMs: 1 };
  }

  async query(query: CodeIntelligenceQuery): Promise<CodeIntelligenceQueryResult> {
    this.#assertOpen();
    const recorded = this.#recording.queryResults.find((result) => result.queryId === query.id);
    if (recorded !== undefined) return recorded;
    const supported = this.#recording.snapshot.capabilities.includes(query.capability);
    return {
      version: 1,
      queryId: query.id,
      snapshotId: query.snapshotId,
      revision: query.revision,
      provider: this.#recording.descriptor.id,
      providerVersion: this.#recording.descriptor.providerVersion,
      status: supported ? 'empty' : 'unsupported',
      facts: [],
      diagnostics: [],
      truncationReasons: [],
      observedDepth: 0,
      observedMaxFanOut: 0,
      bytes: 0,
      durationMs: 0,
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error(`recorded provider ${this.id} is closed`);
  }
}
