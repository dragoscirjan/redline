# redline

Redline reviews Git changes with Pi or OpenCode. Run it locally or in GitHub Actions, then read the findings in your terminal or saved JSON and Markdown files.

[Browse the documentation](https://lunaticthinker.me/projects/redline/).

## Start here

| What you want to do | Guide |
| --- | --- |
| Install Redline or use the source checkout | [Get started](docs/get-started/index.md) |
| Try a review without an API key | [First review](docs/get-started/first-review.md) |
| Connect Pi or OpenCode to a model | [Model setup](docs/get-started/configuration.md) |
| Find the command for staged changes, branches, or commits | [Common commands](docs/commands.md) |
| Understand findings and saved files | [Read the results](docs/results.md) |
| Add GitHub pull-request reviews | [GitHub Actions setup](docs/get-started/github-actions.md) |
| Fix a setup or run failure | [Troubleshooting](docs/troubleshooting.md) |

## A safe source-checkout trial

Requires Node.js 24 and Git. From the Redline checkout:

```sh
node bin/redline.mjs --help
node bin/redline.mjs review --repository /path/to/your/repository --harness echo --indexing disabled
```

Replace the path with a Git repository that has a commit and tracked changes. `echo` checks capture and output without a model, API key, or indexer. It always returns a clean answer, so it does not judge code quality.

The npm package is `@dragoscirjan/redline`. Installation requires a published version; the [getting-started guide](docs/get-started/index.md) includes both npm and source-checkout paths. Pi/OpenCode and optional indexers are installed separately.

## How review works

Redline captures the selected change, runs a fixed prompt per eligible file, validates findings against the diff, and saves JSON and Markdown output. The reviewed code, tests and installers are never executed. Model findings still need human judgment.

GitHub Actions can also publish reviews and a managed summary when publication credentials are configured. The [setup guide](docs/get-started/github-actions.md) starts with downloadable artifacts and a pinned workflow.

For details, use the [CLI reference](docs/local-cli.md), [GitHub action reference](docs/github-composite-action.md), or [architecture](docs/portable-architecture.md). Benchmarks and other engineering references remain in the documentation site's sidebar.

## Product direction

The current GitHub product is the first integration, not the intended boundary of the review engine. The longer-term direction is one validated review core that can review a local change, publish to different forges, and present the same findings in different editors.

Git and GitHub are available now. The other forge, VCS and editor integrations below are planned. The architecture separates three integration layers:

| Layer | Integrations | Responsibility |
| --- | --- | --- |
| Revision source | Git, Jujutsu, Mercurial | Resolve an exact change and build the bounded authoritative review bundle. |
| Forge | GitHub, Forgejo, Gitea, GitLab, Bitbucket Cloud | Resolve pull or merge request metadata and publish validated results. |
| Editor | VS Code, VSCodium, Zed | Start local reviews and present progress, evidence, coverage, and suggestions. |

Forge and editor integrations remain thin adapters. They must not own review policy, model-provider behavior, evidence validation, or synthesis.

## Roadmap

Priorities 1–4 are the next intended product work. The remaining epics are open but unscheduled; they have no promised release dates.

### Near term

1. [Local Git review CLI](https://github.com/dragoscirjan/redline/issues/178) — complete npm delivery and source-independent installation verification. Revision-range and staged/unstaged reviews are already implemented without requiring a forge.
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

Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing the repository. Work happens on focused branches in dedicated worktrees. See [release operations](docs/local-cli.md#release-operations) for the npm CI flow and its verification requirements.
