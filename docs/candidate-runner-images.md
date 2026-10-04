# Candidate runner images

Issue [#77](https://github.com/dragoscirjan/redline/issues/77) adds a separate manual publisher for reviewed runner source before the corresponding host contract merges.

## Current status

Infrastructure PR [#78](https://github.com/dragoscirjan/redline/pull/78) merged with owner approval. Owner-approved [run 37219185669](https://github.com/dragoscirjan/redline/actions/runs/37219185669) published base, Pi, and OpenCode candidates from reviewed source `62067e8b4204ab03cd118451a199631a954308ca`. Its provenance verifies both architectures, source bootstrap bytes, Pi 0.87.1, and OpenCode 1.18.32. Independent registry inspection matched all recorded architecture descriptors, and all ten source-file hashes matched that commit.

PR [#76](https://github.com/dragoscirjan/redline/pull/76) proposes the verified immutable backend digests. The real published Pi and OpenCode images pass controlled native model-contract tests without a source-bootstrap override. OpenCode testing exposed a host-side token-limit handling defect, and the host correction now rejects apparent completion after that failure. The runner build-context files are unchanged. Complete live GLM review remains unverified. Publication and these checks do not authorize merging #76.

## Approval and supported scope

The workflow supports this public, personally owned GitHub repository on hosted runners. Organization ownership, delegated publishers, private source repositories, forks, and self-hosted runners are unsupported.

The definition must run through `workflow_dispatch` on `main`. Both the original actor and rerun actor must be the repository owner. Each job checks out the captured `github.workflow_sha`, not the selected PR source. Preflight uses only Node built-ins and does not install repository dependencies or import selected-source scripts.

The operator supplies exactly an open same-repository PR number, its reviewed 40-character head SHA, and the fixed acknowledgement `publish-reviewed-sha-and-confirm-admin-bypass-disabled`. The base must be `main`. The head must match during preflight and again after environment approval, before the first build.

Approval authorizes that immutable source SHA. If the PR moves after approval, the build still uses the original validated blob objects. The workflow does not promise a current PR head at publication time. Cancel the run to revoke in-flight approval. Approval does not authorize merging the source, changing production pins, or publishing stable tags.

## Environment setup

Create `candidate-images` before dispatch. A workflow reference to a missing environment can otherwise create an unprotected environment.

Configure these settings:

- Require exactly the personal repository owner as the user reviewer.
- Allow self-review so that the single owner can approve their dispatch.
- Use custom deployment policies with exactly one branch rule named `main`, not a tag or wildcard.
- Disable administrative bypass in repository settings.
- Review the exact selected source, including Dockerfiles and dependency changes.

Preflight verifies the exposed environment, required-reviewer, self-review, and branch-policy fields before the gated job references the environment. The publisher repeats those checks after approval and before each build-and-push step. Missing, ambiguous, unsupported, or oversized API data stops the operation. Check timestamps describe observations, not a lock on GitHub settings.

Administrative bypass and actual source review remain manual attestations. The API checks do not prove either. The acknowledgement records that the owner completed them.

Top-level workflow permissions are empty. Preflight receives only contents, pull requests, and Actions read permissions. Only the protected publisher receives `packages: write`. Model credentials and the review-publication PAT are not used.

## Source and build boundaries

The trusted helper fetches the selected SHA as Git data. It reads NUL-delimited tree metadata and requires all ten fixed runner files before creating a private build context. It rejects symlinks, submodules, duplicate or unexpected paths, unsupported modes, malformed metadata, files over 2 MiB, and total content over 16 MiB. Tree metadata is limited to 32 KiB; each API response is limited to 1 MiB.

The context contains only the runner Dockerfiles, bootstrap, MCP package manifests and requirements, Pi settings, and OpenCode config/report plugin. The helper reads each blob by object ID and checks its Git identity and byte count. It validates all blobs and supported Dockerfile copy syntax before writing any source paths. `ADD`, `ONBUILD`, copy flags, variables, globs, JSON copy syntax, and non-allowlisted sources are unsupported. A runner change that needs another asset requires a separately reviewed trusted allowlist change.

The publisher never checks out the selected head or uses Git filters. Host credentials, `.git`, ignored changes, `.dockerignore`, installed modules, and coding-agent resources do not enter the context. Registry credentials remain with the trusted registry client. No secrets or arbitrary environment maps become build arguments or mounts.

After maintenance approval, the builder executes the reviewed Dockerfiles. This is not a review workflow and does not relax the product's ban on executing PR code during reviews. Setup uses pinned QEMU and BuildKit images. BuildKit has no insecure or host-network entitlement. Any setup-helper privilege does not apply to the review runtime.

## Publication and verification

The publisher builds `linux/amd64` and `linux/arm64` for base, Pi, and OpenCode. It publishes only `candidate-<full-source-sha>` tags for the fixed runner packages. Both backend builds use the captured base image digest, not its candidate tag. No job changes `latest`, stable tags, production pins, package retention, or PR merge state.

Candidate tags are mutable locators and can move on rerun. Artifact authority is the captured immutable digest. Inspection uses those digest references and requires both unique platform descriptors. For each architecture, a stopped network-disabled container provides bootstrap bytes. The verifier rejects copied symlinks and compares the bytes with the approved source hash. Network-disabled, unprivileged version probes check Pi and OpenCode against the fixed version ARGs in the reviewed Dockerfiles. Cleanup targets only containers created by that inspection.

The bounded version-1 provenance records the source and workflow SHAs, actor, PR number, per-file Git object IDs and SHA-256 hashes, exposed-gate check timestamps, manual attestations, captured image digests, verified platform/bootstrap/version results, and partial failures. It excludes raw provider or subprocess errors, credentials, and source content.

A successful version probe does not prove the model contract or live review quality. Before proposing production pins, independently verify the provenance and compare the current reviewed runner files with its source manifest. Changed runner bytes need another approved candidate. Then run the native integration against the proposed published pins without a source-bootstrap override. Preserve no-tools isolation and the configured GLM model.

## Dispatch and recovery

Obtain separate owner approval for the exact source SHA before each dispatch. The Actions entry is **Publish approved candidate runner images**. Select `main`, supply the reviewed PR number and SHA, complete the manual checklist, and approve the `candidate-images` environment job. The environment must already exist with the protections described above.

Combined build-and-push steps can finish for the approved SHA if the branch moves during a long build. There is no atomic transaction across the three images or between GitHub and GHCR. A later backend or verification failure can leave published candidates behind. Provenance retains captured digests even when verification fails. An interrupted push may leave a published manifest without a captured digest; the report states that limitation rather than claiming nothing was published.

Inspect partial results before retrying. A rerun needs the owner identity and an unchanged current selected PR head at its new preflight and approval checks. It may replace a candidate tag, never an immutable digest. Do not delete packages, change production tags, or merge incompatible host code as recovery.

## Validation limits

Deterministic credential-free tests cover dispatch and rerun identity, stale and foreign heads, environment protection, metadata bounds, unsafe Git modes and paths, supported copy syntax, blob identity, SHA-bound head movement, digest-bound tag movement, partial verification, and secret-safe failures. Local test, typecheck, and docs results belong in the infrastructure PR.

The local `mise run validate` gate runs TypeScript checking, compilation with the Node/Bats tests, and the VitePress build. It does not run formatting, linting, duplication analysis, vulnerability audits, or recorded review-quality evaluation. Issue #79 removes the former references to missing scripts and pins pnpm 10.33.0 for the existing dependency policy. See [Contributing](https://github.com/dragoscirjan/redline/blob/main/CONTRIBUTING.md) for setup and the gate's limits.

The successful owner-approved candidate run proves publication and image inspection for its exact source, not future registry access or live GLM review quality. Local tests do not authorize another dispatch or merge.
