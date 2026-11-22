import { Effect, type Layer, type Scope } from 'effect';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { OpenAiDriver } from '../src/model-runtime/drivers/openai.ts';
import { AnthropicDriver } from '../src/model-runtime/drivers/anthropic.ts';
import { GeminiDriver } from '../src/model-runtime/drivers/gemini.ts';
import { loadConfiguration, parseConfiguration, validateOfflineProfile } from '../src/application/configuration.ts';
import { RunBudget } from '../src/application/budget.ts';
import { ModelBindings } from '../src/model-runtime/bindings.ts';
import { McpClient } from '../src/mcp/client.ts';
import { ToolDispatcher, type ReviewToolResult } from '../src/mcp/tools.ts';
import { ModelConversation } from '../src/model-runtime/conversation.ts';
import type { ConversationResult } from '../src/model-runtime/types.ts';
import { CodeContextProvider, type CodeContextResult } from '../src/code-context/provider.ts';
import { FileReviewValidator, parseFileReviewDocument, type FileReviewDocument } from '../src/review/report.ts';
import { buildRemediation, renderSuggestion, type Remediation } from '../src/review/remediation.ts';
import { synthesizeReview } from '../src/review/synthesis.ts';
import type { ReviewDocument, ValidatedFinding } from '../src/review/types.ts';
import { ReviewWriter } from '../src/review/writer.ts';
import { ReviewReuseStore } from '../src/review/reuse.ts';
import { buildReviewPrompt } from '../src/review/policy.ts';
import { DiagnosticImporter, type ImportedDiagnostics } from '../src/review/diagnostics.ts';
import { ReviewEngine } from '../src/review/engine.ts';
import { WarmupService, type WarmupReport } from '../src/application/warmup.ts';
import { createReviewLayer } from '../src/application/composition.ts';
import type { ReviewApplication } from '../src/application/review.ts';
import { OperationalEvents } from '../src/observability/service.ts';
import type { CandidateValidationResult } from '../src/review/report.ts';
import type { ReviewDependencies } from '../src/application/composition.ts';
import { GitHubPublisher } from '../src/publish/github.ts';
import { ForgejoGiteaPublisher } from '../src/publish/forgejo-gitea.ts';
import { GitLabPublisher } from '../src/publish/gitlab.ts';
import { BitbucketCloudPublisher } from '../src/publish/bitbucket-cloud.ts';
import { AzureDevOpsPublisher } from '../src/publish/azure-devops.ts';
import { PublicationService, type PublicationDependencies } from '../src/publish/service.ts';
import type { PublicationReceipt } from '../src/publish/types.ts';
import { formatCliReview } from '../src/reporter/cli/format.ts';
import { formatFileReview } from '../src/reporter/file/format.ts';
import { formatGitHubReview } from '../src/reporter/github/format.ts';
import { ReviewRpcService, type RpcRunHandle } from '../src/rpc/service.ts';
import { EditorClient } from '../src/editor/client.ts';
import { JujutsuRevisionSource } from '../src/revision-source/jujutsu.ts';
import { MercurialRevisionSource } from '../src/revision-source/mercurial.ts';
import type { CapturedRevision } from '../src/revision-source/types.ts';

describe('architecture prototypes', () => {
  it.each([
    ['RPC initialization', () => new ReviewRpcService().initialize(undefined)],
    ['RPC result queries', () => new ReviewRpcService().query(undefined)],
    ['RPC cancellation', () => new ReviewRpcService().cancel(undefined)],
    ['RPC shutdown', () => new ReviewRpcService().shutdown()],
    ['editor connection', () => Effect.scoped(new EditorClient().connect(undefined))],
    ['editor review start', () => Effect.scoped(new EditorClient().start(undefined, undefined))],
    ['editor result queries', () => new EditorClient().query(undefined, undefined)],
    ['editor cancellation', () => new EditorClient().cancel(undefined, undefined)],
    ['evidence navigation', () => new EditorClient().navigate(undefined)],
    ['suggestion application', () => new EditorClient().applySuggestion(undefined)],
  ] as const)('does not activate %s from an unfinished client/service', async (_name, operation) => {
    await expect(Effect.runPromise(operation())).rejects.toThrow('Not implemented');
  });
  it.each([
    ['Jujutsu', new JujutsuRevisionSource(undefined)], ['Mercurial', new MercurialRevisionSource(undefined)],
  ] as const)('does not fabricate a %s capture or fall back to Git', async (_name, source) => {
    await expect(source.capture(new AbortController().signal)).rejects.toThrow('Not implemented');
  });
  it('preserves scoped RPC starts and the existing revision-source result seam', () => {
    expectTypeOf<ReviewRpcService['start']>().returns.toEqualTypeOf<Effect.Effect<RpcRunHandle, Error, Scope.Scope>>();
    expectTypeOf<JujutsuRevisionSource['capture']>().returns.toEqualTypeOf<Promise<CapturedRevision>>();
    expectTypeOf<MercurialRevisionSource['capture']>().returns.toEqualTypeOf<Promise<CapturedRevision>>();
  });

  const publishers = [
    ['GitHub', new GitHubPublisher()], ['Forgejo/Gitea', new ForgejoGiteaPublisher()],
    ['GitLab', new GitLabPublisher()], ['Bitbucket Cloud', new BitbucketCloudPublisher()], ['Azure DevOps', new AzureDevOpsPublisher()],
  ] as const;
  it.each(publishers)('does not report an observed %s head from an unfinished adapter', async (_name, publisher) => {
    await expect(Effect.runPromise(publisher.currentHead(undefined))).rejects.toThrow('Not implemented');
  });
  it.each(publishers)('does not claim a %s file review was published', async (_name, publisher) => {
    await expect(Effect.runPromise(publisher.publishFileReview(undefined, undefined))).rejects.toThrow('Not implemented');
  });
  it.each(publishers)('does not claim a %s managed summary was updated', async (_name, publisher) => {
    await expect(Effect.runPromise(publisher.upsertSummary(undefined, '', ''))).rejects.toThrow('Not implemented');
  });
  it.each([
    ['CLI', formatCliReview], ['file', formatFileReview], ['GitHub', formatGitHubReview],
  ] as const)('does not fabricate a %s report projection', (_name, format) => {
    expect(() => format(undefined)).toThrow('Not implemented');
  });
  it('keeps publication replay separate from model and tool dependencies', () => {
    expectTypeOf<PublicationService['publish']>().returns.toEqualTypeOf<Effect.Effect<PublicationReceipt, Error>>();
    expectTypeOf<ReviewDependencies>().not.toHaveProperty('publisher');
    expectTypeOf<PublicationDependencies>().not.toHaveProperty('drivers');
    expectTypeOf<PublicationDependencies>().not.toHaveProperty('mcp');
  });

  it.each([
    ['artifact writes', () => new ReviewWriter().write(undefined, undefined, undefined)],
    ['artifact replay reads', () => new ReviewWriter().read(undefined, undefined)],
    ['cache lookup', () => new ReviewReuseStore().lookup(undefined, undefined)],
    ['cache persistence', () => new ReviewReuseStore().persist(undefined, undefined, undefined)],
    ['operational logging', () => new OperationalEvents().record(undefined)],
    ['telemetry export', () => new OperationalEvents().exportTelemetry(undefined, undefined)],
  ] as const)('does not perform %s before implementation', async (_name, operation) => {
    await expect(Effect.runPromise(operation())).rejects.toThrow('Not implemented');
  });
  it('does not manufacture prompts or claim that review orchestration is implemented', () => {
    expectTypeOf<typeof buildReviewPrompt>().parameter(0).toEqualTypeOf<import('../src/review/types.ts').FileReviewInput>();
    expectTypeOf<ReviewEngine['reviewFile']>().returns.toEqualTypeOf<Effect.Effect<CandidateValidationResult, Error, Scope.Scope>>();
    expectTypeOf<ReviewEngine['reviewChange']>().returns.toEqualTypeOf<Effect.Effect<ReviewDocument, Error, Scope.Scope>>();
    expectTypeOf<WarmupService['run']>().returns.toEqualTypeOf<Effect.Effect<WarmupReport, Error, Scope.Scope>>();
    expectTypeOf<DiagnosticImporter['importSarif']>().returns.toEqualTypeOf<Effect.Effect<ImportedDiagnostics, Error>>();
    expectTypeOf<typeof createReviewLayer>().returns.toEqualTypeOf<Layer.Layer<ReviewApplication, Error>>();
  });

  it.each([
    ['review parsing', () => parseFileReviewDocument('')],
    ['suggestion rendering', () => renderSuggestion([], [])],
    ['cross-file synthesis', () => synthesizeReview([], { fileReviews: 25, inlineComments: 100 })],
  ] as const)('does not fabricate %s output', (_name, operation) => {
    expect(operation).toThrow('Not implemented');
  });
  it('does not validate a clean document without an authoritative validation implementation', () => {
    const document: FileReviewDocument = {
      version: 4, fileId: '000001', outcome: 'clean', reason: undefined,
      findings: [], candidateIndices: [], rejectedCandidates: [], contextRequests: [],
    };
    expect(() => new FileReviewValidator().validateCandidates(document, undefined)).toThrow('Not implemented');
    expectTypeOf<FileReviewValidator['validateFinding']>().returns.toEqualTypeOf<ValidatedFinding>();
    expectTypeOf<typeof buildRemediation>().returns.toEqualTypeOf<Promise<Remediation>>();
  });

  it('does not connect or invent MCP discovery results before implementation', async () => {
    await expect(Effect.runPromise(Effect.scoped(new McpClient().connect(undefined)))).rejects.toThrow('Not implemented');
    await expect(Effect.runPromise(new McpClient().listTools(undefined))).rejects.toThrow('Not implemented');
    await expect(Effect.runPromise(new McpClient().callTool(undefined, undefined))).rejects.toThrow('Not implemented');
  });
  it('keeps tool and conversation lifecycles scoped and context resolution provider-neutral', () => {
    expectTypeOf<ToolDispatcher['call']>().returns.toEqualTypeOf<Effect.Effect<ReviewToolResult, Error, Scope.Scope>>();
    expectTypeOf<ModelConversation['run']>().returns.toEqualTypeOf<Effect.Effect<ConversationResult, Error, Scope.Scope>>();
    expectTypeOf<CodeContextProvider['resolve']>().returns.toEqualTypeOf<Effect.Effect<CodeContextResult, Error>>();
  });

  it('does not accept undecided configuration as a validated configuration', () => {
    expect(() => parseConfiguration(undefined)).toThrow('Not implemented');
  });
  it.each([
    ['configuration loading', () => loadConfiguration(undefined)],
    ['offline provisioning', () => validateOfflineProfile(undefined)],
    ['binding resolution', () => new ModelBindings().resolve(undefined, undefined, [new OpenAiDriver()])],
    ['credential selection', () => new ModelBindings().resolveCredential(undefined)],
    ['budget enforcement', () => new RunBudget().check()],
    ['usage accounting', () => new RunBudget().record(undefined)],
    ['remaining-budget reporting', () => new RunBudget().snapshot()],
  ] as const)('keeps %s explicitly unfinished', async (_name, operation) => {
    await expect(Effect.runPromise(operation())).rejects.toThrow('Not implemented');
  });

  const drivers = [
    ['OpenAI', new OpenAiDriver()], ['Anthropic', new AnthropicDriver()], ['Gemini', new GeminiDriver()],
  ] as const;
  it.each(drivers)('keeps %s generation unfinished instead of returning a fake response', async (_name, driver) => {
    await expect(Effect.runPromise(driver.generate(undefined, undefined))).rejects.toThrow('Not implemented');
  });
  it.each(drivers)('does not advertise %s capabilities before implementation', async (_name, driver) => {
    await expect(Effect.runPromise(driver.capabilities(undefined))).rejects.toThrow('Not implemented');
  });
});
