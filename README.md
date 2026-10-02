# redline

Automated pull request code review, smaller and self-hosted: a GitHub Action that reviews a pull request's diff with a fixed review policy and publishes a managed summary plus bounded inline comments.

## How it works

The review fetches the pull request's base and head commits as Git data, builds a bounded context bundle, and runs the Pi or OpenCode backend inside a digest-pinned container. Findings are schema-validated, mapped to the reviewed diff, and published through a host-side GitHub client. Pull request code is never checked out or executed.

## Adoption

Call the reusable review workflow from a `pull_request_target` workflow in your repository. See [docs/reusable-review-workflow.md](docs/reusable-review-workflow.md) for the caller pattern, secret mapping, and version pinning.

Product documentation:

- [GitHub composite action contract](docs/github-composite-action.md)
- [Reusable review workflow](docs/reusable-review-workflow.md)
- [Runnable review configuration](docs/runnable-review-configuration.md)
- [Container staging](docs/container-staging.md)
- [Review reporting](docs/review-reporting.md)

## Development

Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing the repository. Work happens on focused branches in dedicated worktrees; releases publish immutable `vMAJOR.MINOR.PATCH` tags through the guarded release workflow.
