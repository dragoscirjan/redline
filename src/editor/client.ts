import { Effect, type Scope } from 'effect';

/** Shared client contracts; native VS Code/Zed/Neovim APIs and candidate LSP/ACP adapters are not selected here. */
export type EditorStartup = unknown;
export type EditorConnection = unknown;
export type EditorReviewRequest = unknown;
export type EditorRunHandle = unknown;
export type EditorResultQuery = unknown;
export type EditorReviewView = unknown;
export type EditorCancelRequest = unknown;
export type EditorCancellation = unknown;
export type EditorEvidenceLocation = unknown;
export type EditorSuggestionEdit = unknown;

export class EditorClient {
  connect(startup: EditorStartup): Effect.Effect<EditorConnection, Error, Scope.Scope> {
    // Use trusted CLI selection and workspace trust; opening a project must not start paid reviews or install tools.
    return Effect.fail(new Error('Not implemented: EditorClient.connect'));
  }

  start(connection: EditorConnection, request: EditorReviewRequest): Effect.Effect<EditorRunHandle, Error, Scope.Scope> {
    // Start only an explicit review through the shared service; keep provider policy and credentials out of clients.
    return Effect.fail(new Error('Not implemented: EditorClient.start'));
  }

  query(connection: EditorConnection, request: EditorResultQuery): Effect.Effect<EditorReviewView, Error> {
    // Present findings, incomplete coverage and operational failure distinctly with bounded progress/results.
    return Effect.fail(new Error('Not implemented: EditorClient.query'));
  }

  cancel(connection: EditorConnection, request: EditorCancelRequest): Effect.Effect<EditorCancellation, Error> {
    // Request matching-run cancellation and clean up only owned client/process resources.
    return Effect.fail(new Error('Not implemented: EditorClient.cancel'));
  }

  navigate(location: EditorEvidenceLocation): Effect.Effect<void, Error> {
    // Navigate authoritative source/base/deleted evidence using snapshot and buffer identity checks.
    return Effect.fail(new Error('Not implemented: EditorClient.navigate'));
  }

  applySuggestion(edit: EditorSuggestionEdit): Effect.Effect<void, Error> {
    // Require explicit user action and a matching document version; never apply fixes automatically.
    return Effect.fail(new Error('Not implemented: EditorClient.applySuggestion'));
  }
}
