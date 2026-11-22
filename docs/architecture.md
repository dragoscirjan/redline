# Architecture and implementation status

[Issue #234](https://github.com/dragoscirjan/redline/issues/234) defines one shared review engine for local CLI, Docker, stdio RPC and later forge/editor integrations. The source now contains both working Git capture and the approved remaining architecture prototypes. These are different delivery states.

## Working behavior

`src/revision-source/git.ts`, `src/context-bundle.ts` and `src/review-eligibility.ts` implement bounded immutable Git capture and deterministic context bundles. See [Git capture](./capture.md) for the API, artifacts, privacy requirements and tested limits.

The CLI still supports help/status and rejects review/RPC execution. No prototype has been wired into those entrypoints. Docker remains the existing unfinished definition; production review/release workflows remain parked.

## Intended composition

```text
trusted startup configuration
  -> model bindings, execution profile and one shared run budget
  -> createReviewLayer(configuration, ReviewDependencies)
       revision source
       model-driven warmup -> tools / selected code-context provider
       review engine -> binding-local model conversation -> native driver / tools
       central validation -> remediation / synthesis -> authoritative JSON writer
       optional result reuse and content-free operational events

validated authorized artifact + separate publication authorization
  -> PublicationService(PublicationDependencies)
       artifact validation / revision and ownership guards
       selected forge publisher

CLI / stdio RPC / shared editor client
  -> the same application, not separate review engines
```

This is the proposed dependency structure, not an executed pipeline. `ReviewDependencies` has no publisher. `PublicationDependencies` has no model drivers or MCP client. Publication replay must not rerun models or infer findings from Markdown. These declarations express the boundary; they do not implement or prove authorization.

Effect `4.1.5` remains the only added dependency. It is intended to own application lifecycle, scopes, expected operational failure, bounded concurrency, deadlines and shared retry accounting. SDKs should own transport and native protocol details. Pure validators, synthesis and formatters remain ordinary functions. Do not introduce a runtime per helper or a second SDK agent loop.

## Source map

Every new callable is explicitly unfinished. Type/interface declarations need no body. Constructors that exist only retain their selected dependency/selection value; they do not connect, inspect private configuration or execute tools.

| Files | Intended responsibility |
| --- | --- |
| `application/configuration.ts` | Trusted configuration and offline-profile validation without repository-selected credentials, executables or defaults. |
| `application/budget.ts` | One budget shared across warmup, review, recovery and finalization. |
| `application/warmup.ts` | Model-driven diagnostics that distinguish assertions, discovery, calls and successful results. |
| `application/composition.ts` | Explicit application dependencies and the shared Effect layer factory. |
| `model-runtime/types.ts`, `bindings.ts` | Separate SDK identity, native protocol, provider, model binding, role and selected credential. |
| `model-runtime/conversation.ts` | One scoped bounded model/tool conversation with binding-local state. |
| `model-runtime/drivers/openai.ts` | Intended native Chat Completions/Responses boundary. |
| `model-runtime/drivers/anthropic.ts` | Intended native Messages boundary. |
| `model-runtime/drivers/gemini.ts` | Intended native generateContent/streaming boundary. |
| `mcp/client.ts`, `tools.ts` | Scoped configured connections and explicit tool dispatch under the selected profile and shared budget. |
| `code-context/provider.ts` | Selected indexing/query observations and bounded source-resolved context, not a restored host-indexing pipeline. |
| `review/types.ts`, `engine.ts` | Neutral finding contracts and per-file/change orchestration declarations. |
| `review/report.ts` | Existing versioned document declarations and central authoritative evidence validation. |
| `review/remediation.ts`, `synthesis.ts` | Source-backed suggestions/fix prompts and deterministic cross-file grouping/budgets. |
| `review/writer.ts` | Core-owned validation, redaction, JSON persistence and trusted replay reads. |
| `review/policy.ts`, `diagnostics.ts` | Fixed policy/trusted focus and bounded pre-produced diagnostic import. |
| `review/reuse.ts` | Compatible trusted answer reuse, separate from provider-owned index persistence. |
| `reporter/cli/format.ts`, `reporter/file/format.ts`, `reporter/github/format.ts` | Pure validated-report projections, not JSON writers or publication transports. |
| `publish/types.ts`, `service.ts` | Native forge transport contracts and separately authorized artifact publication. |
| `publish/github.ts`, `forgejo-gitea.ts`, `gitlab.ts`, `bitbucket-cloud.ts`, `azure-devops.ts` | Named forge boundaries with their native identity, position and capability differences retained. |
| `rpc/service.ts` | Internal handlers targeting the existing protocol-1.0 contract, not a new wire schema. |
| `editor/client.ts` | Shared explicit-review/query/cancel/navigation/edit client boundary. |
| `observability/service.ts` | Allowlisted operational metadata and explicitly consented telemetry export. |
| `revision-source/jujutsu.ts`, `mercurial.ts` | Later native VCS capture, not Git conversion or implicit colocated-Git fallback. |

The concrete SDK implementations are not selected by these provider names. Three provider prototypes do not satisfy the required proof of two real SDK families in one concurrent validated review. No SDK request, tool execution or capability enforcement is implemented here.

Forgejo/Gitea sharing still requires separate capability fixtures. GitLab self-managed versions, Bitbucket Server/Data Center and Azure DevOps deployment/auth variants are not implicitly supported. Jujutsu/Mercurial demand and activation gates remain. Source prototypes do not activate an integration.

## Contract reuse and deferred shapes

The neutral finding/evidence/verification/remediation/synthesis declarations are taken from `src.pre-v4/review/types.ts`. Provider-neutral graph references and evidence-request directions are retained from the archived code-context contracts. Per-file document versions 4, 3 and 2 are declared without changing their fields. Their parsers and validators are not implemented by copying declarations.

The aggregate report/driver metadata migration is not settled. Neither are SDK capabilities, native continuation payloads, MCP configuration, cache identity, artifact trust, publication receipts, privacy events or editor projections. These use named `unknown` aliases where no schema has been agreed. They are not nominal types, runtime validation or evidence of authorization. Do not access or persist their fields until their specification is accepted.

No fake legacy harness values, default endpoints, role routes, output modes, cache TTLs, collector settings or credential formats were invented. No competing Zod/Effect/handwritten validators were added. The existing authoritative schema remains the reuse baseline until an explicitly versioned migration.

## Unfinished bodies

Concrete methods return a positive intended result type but fail explicitly with `Not implemented`. They do not return empty reviews, success receipts, available capabilities or fake cache misses. No failure occurs merely because a module is imported.

`ReviewApplication.review(request)` remains a prototype. `createReviewLayer` is not called by the CLI. The native VCS prototypes keep the existing Promise-based capture result seam; the future application scope must own acquisition, cancellation and disposal. The working Git adapter and its resource behavior were not stubbed or replaced.

The RPC prototype targets JSON-RPC 2.0, Content-Length stdio and protocol 1.0 one-shot/persistent semantics. It does not implement framing, queues or lifecycle behavior and does not replace the delivered contract with LSP. The shared editor declaration does not select LSP/ACP or add native VS Code, Zed or Neovim packages. Those require the transport/capability decisions in #182-A and #234.

## Tests and evidence limits

`test/architecture.test.ts` checks public type contracts and explicit unfinished-call failures. It does not assert provider compatibility, review quality, successful privacy filtering or publication. `test/package.test.ts` checks that every approved module is compiled/shipped and imports safely under offline-installed Node and Bun. The existing real Git capture, CLI behavior, archive exclusion and owned-process cancellation checks remain active.

The project retains Vitest 3 and tests Effects directly. No `@effect/vitest`, SDK, editor toolchain, installer or framework was added. Builds discover active `src/**/*.ts`, not the parked source. Tests still discover only active `test/**/*.test.ts` and Bats files.

A passing typecheck/import/failure test is not feature completion. Native model protocols, MCP compatibility, mixed-SDK execution, model/tool cleanup, actual privacy controls, editor behavior, live forge publication, Windows behavior and Docker execution remain unverified or unimplemented as documented for their slice.

## Reuse and preservation

- Working capture was adapted from the archived Git adapter, Git-only process helpers, bundle builder and eligibility policy. Its implemented bodies are unchanged by the added prototypes.
- The offline package fixture adapts the archived package/npm dependency helpers without registry access or checkout symlinks.
- Existing CLI bodies, launchers, build script, capture tests, container definitions and test configuration are preserved by this architecture-only follow-up.
- Archives and owner edits remain untouched. No active module imports them or uses them as a fallback.
- Draft-local skills/protected instructions still need separately approved reconciliation. Current-main guidance was explicitly approved for this task; this scaffold does not change those rules.

## Next implementation decisions

Use the [existing task plan](https://github.com/dragoscirjan/redline/issues/234#issuecomment-7054237458) to resolve native SDK families/versions, binding and error semantics, budget limits, configuration/output migration, and the temporary warmup-stop replacement before implementing dependent bodies. Then port authoritative behavior and regression tests in bounded TDD slices.

Full #234 acceptance also needs actual mixed-SDK loopback proof, real model/tool cancellation, parity/quality evaluation with agreed thresholds, RPC migration and staged forge/editor integration evidence. This prototype set is for architectural review. It does not authorize those implementations, new dependencies, automatic publication, merging or release merely because structural checks pass.
