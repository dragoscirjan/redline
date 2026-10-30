# redline

Redline reviews Git changes locally or through its GitHub Action. It uses a fixed review policy, validates findings against the diff, and writes JSON and Markdown artifacts. When publication credentials are supplied, the GitHub integration can also publish a managed summary and bounded inline comments.

## How it works

The review fetches the pull request's base and head commits as Git data, builds a bounded context bundle, and runs Pi or OpenCode with tools disabled and isolated generated configuration. Findings are schema-validated, mapped to the reviewed diff, and published through a host-side GitHub client. Pull request code is never checked out or executed.

## Local Git reviews

The `redline review` CLI needs no GitHub repository, pull request, remote URL, or publication token. It supports branch comparisons and staged/unstaged changes, with a terminal reporter and deterministic review artifacts.

```bash
# Source-checkout smoke tests; echo does not perform model-based review.
node bin/redline.mjs review --base main --head HEAD --harness echo --indexing disabled
node bin/redline.mjs review --worktree all --harness echo --indexing disabled
```

The npm distribution is `@dragoscirjan/redline` for Node.js 24, released through Changesets after successful main CI. Pi/OpenCode binaries are installed separately. Indexed cross-file context is enabled by default through separately installed pinned CGC; unavailable context is reported as file-only. `--indexing required` rejects those gaps before model review. See [Local CLI](docs/local-cli.md) for configuration, credentials, output bounds, and exit statuses, and [Portable architecture](docs/portable-architecture.md) for adapter boundaries. Future VCS/reporter values are recognized but fail explicitly until implemented.

## Adoption

Call the reusable review workflow from a `pull_request_target` workflow in your repository. See [docs/reusable-review-workflow.md](docs/reusable-review-workflow.md) for the caller pattern, secret mapping, and version pinning.

Product documentation:

- [Local Git CLI](docs/local-cli.md)
- [Portable application architecture](docs/portable-architecture.md)

- [GitHub composite action contract](docs/github-composite-action.md)
- [Reusable review workflow](docs/reusable-review-workflow.md)
- [Dogfood reviews](docs/dogfood-review.md)
- [Runnable review configuration](docs/runnable-review-configuration.md)
- [Review eligibility](docs/review-eligibility.md)
- [Review reporting](docs/review-reporting.md)
- [Review performance benchmark](docs/performance-benchmark.md)
- [Checkout and exact-revision benchmark](docs/checkout-benchmark.md)
- [Model execution benchmark](docs/model-execution-benchmark.md)

## Product direction

The current GitHub product is the first integration, not the intended boundary of the review engine. The longer-term direction is one validated review core that can review a local change, publish to different forges, and present the same findings in different editors.

The architecture separates three integration layers:

| Layer | Planned integrations | Responsibility |
| --- | --- | --- |
| Revision source | Git, Jujutsu, Mercurial | Resolve an exact change and build the bounded authoritative review bundle. |
| Forge | GitHub, Forgejo, Gitea, GitLab, Bitbucket Cloud | Resolve pull or merge request metadata and publish validated results. |
| Editor | VS Code, VSCodium, Zed | Start local reviews and present progress, evidence, coverage, and suggestions. |

Forge and editor integrations remain thin adapters. They must not own review policy, model-provider behavior, evidence validation, or synthesis.

## Roadmap

Priorities 1–4 are the next intended product work. The remaining epics are open but unscheduled; they have no promised release dates.

### Near term

1. [Local Git review CLI](https://github.com/dragoscirjan/redline/issues/178) — publish `@dragoscirjan/redline`; review explicit revision ranges plus staged and unstaged working-tree changes without requiring a forge.
2. [Stable editor-facing JSON-RPC protocol](https://github.com/dragoscirjan/redline/issues/179) — versioned schemas, capabilities, progress, cancellation, diagnostics, evidence, and results over standard input and output.
3. [GitHub integration over the shared engine](https://github.com/dragoscirjan/redline/issues/180) — make GitHub a thin metadata and publication adapter. The composite action remains the execution primitive; the reusable workflow remains an optional secure adoption wrapper.
4. [Forgejo and Gitea integrations](https://github.com/dragoscirjan/redline/issues/181) — one shared adapter where the APIs are compatible, with separately tested workflow templates for each forge.

### Later

5. [VS Code and VSCodium extensions](https://github.com/dragoscirjan/redline/issues/182) — one thin JSON-RPC client in this repository, published to Visual Studio Marketplace and Open VSX.
6. [GitLab support](https://github.com/dragoscirjan/redline/issues/183) — GitLab.com and self-managed merge request publication plus a maintained GitLab CI entrypoint.
7. [Native Jujutsu support](https://github.com/dragoscirjan/redline/issues/184) — review jj changes, revisions, bookmarks, and workspaces without reducing them to Git branch semantics.
8. [Bitbucket Cloud support](https://github.com/dragoscirjan/redline/issues/185) — pull request publication and Bitbucket Pipelines integration; Data Center is deferred.
9. [Native Mercurial support](https://github.com/dragoscirjan/redline/issues/186) — review changesets, bookmarks, revision ranges, and working-directory changes without a Git mirror.
10. [Zed extension](https://github.com/dragoscirjan/redline/issues/187) — a thin client over the same JSON-RPC protocol, with explicit degradation where Zed lacks an equivalent editor capability.

The dependency shape is intentionally small:

```text
Git CLI (#178)
├── JSON-RPC protocol (#179)
│   ├── VS Code / VSCodium (#182)
│   └── Zed (#187)
├── GitHub adapter (#180)
│   ├── Forgejo / Gitea (#181)
│   ├── GitLab (#183)
│   └── Bitbucket Cloud (#185)
├── Jujutsu adapter (#184)
└── Mercurial adapter (#186)
```

Docker or Podman sandboxing remains a separate future hardening milestone. It is not a prerequisite for documenting or designing these adapters, and none of the roadmap items may weaken the current rule that repository content is inert data and is never executed during review.

## Development

Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing the repository. Work happens on focused branches in dedicated worktrees; releases publish immutable `vMAJOR.MINOR.PATCH` tags through the guarded release workflow.
