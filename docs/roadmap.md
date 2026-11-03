# Roadmap

Redline's goal is one review engine for local changes, forges and editors. This page separates available capabilities from planned integrations. Tracking issues contain the remaining work and acceptance criteria; they do not promise release dates.

## Available today

- Local Git reviews of branches, commits and staged or unstaged changes. [CLI milestone #178](https://github.com/dragoscirjan/redline/issues/178).
- A versioned stdio JSON-RPC protocol for progress, cancellation and results. [Protocol milestone #179](https://github.com/dragoscirjan/redline/issues/179).
- GitHub Actions reviews, JSON/Markdown artifacts and optional publication of file reviews and a managed summary.
- An image that runs Redline with Node, Bun, Python, Pi, OpenCode and the requested MCP packages installed. [Docker milestone #203](https://github.com/dragoscirjan/redline/issues/203).

The [Docker guide](/docker-workers) explains usage and limits. Docker is started externally; Redline does not orchestrate containers. Image builds follow a successful new npm publication and use the same version tag. The npm CLI remains available without Docker.

## Next integration work

- [GitHub adapter over the shared engine #180](https://github.com/dragoscirjan/redline/issues/180). Consolidate GitHub metadata and publication behind the shared application. Existing GitHub reviews are already available.
- [Forgejo and Gitea #181](https://github.com/dragoscirjan/redline/issues/181). Share compatible API behavior and provide separately tested workflow templates.
- [Read-only MCP analysis #209](https://github.com/dragoscirjan/redline/issues/209). Expose approved analysis tools to the review model. Installed server packages alone do not enable model tool access.

## Further integration targets

These integrations are planned, not available capabilities:

| Integration | Goal |
| --- | --- |
| [VS Code and VSCodium #182](https://github.com/dragoscirjan/redline/issues/182) | A thin JSON-RPC client published to Visual Studio Marketplace and Open VSX. |
| [GitLab #183](https://github.com/dragoscirjan/redline/issues/183) | GitLab.com and self-managed merge requests, with a maintained CI entrypoint. |
| [Jujutsu #184](https://github.com/dragoscirjan/redline/issues/184) | Native changes, revisions, bookmarks and workspaces, without reducing them to Git branch semantics. |
| [Bitbucket Cloud #185](https://github.com/dragoscirjan/redline/issues/185) | Pull request publication and Pipelines integration. Data Center remains deferred. |
| [Mercurial #186](https://github.com/dragoscirjan/redline/issues/186) | Native changesets, bookmarks, revision ranges and working-directory changes, without a Git mirror. |
| [Zed #187](https://github.com/dragoscirjan/redline/issues/187) | A thin JSON-RPC client that reports unsupported editor capabilities explicitly. |

## How the integrations fit

Revision sources capture a change, forge adapters handle pull-request metadata and publication, and editor clients display progress and findings. These integrations share review policy, model execution, evidence validation and synthesis rather than implementing their own review engines.

```text
Git CLI (#178)
├── JSON-RPC protocol (#179)
│   ├── VS Code / VSCodium (#182)
│   └── Zed (#187)
├── Redline Docker image (#203)
│   └── GitHub adapter (#180)
│       ├── Forgejo / Gitea (#181)
│       ├── GitLab (#183)
│       └── Bitbucket Cloud (#185)
├── Jujutsu adapter (#184)
└── Mercurial adapter (#186)
```

Repository content remains data and is never executed during review. Podman is not a supported container engine. Managed local model runtimes and malicious-host protection are future work; Docker does not protect against its host administrator or kernel. See the [architecture reference](/portable-architecture) for implementation boundaries.
