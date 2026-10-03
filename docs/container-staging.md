# Container staging

Redline prepares each review container through `createContainerStagingLauncher()` in `src/container-staging.ts`. The launcher creates and populates the container only after the host has validated the review bundle and assembled the fixed policy and bounded untrusted context.

The GitHub Action calls this launcher when review inputs are supplied. The envelope v2 and policy v3 changes described below are not deployable with the existing runner image pins. They require rebuilt images and a reviewed digest-pin update.

## Container lifecycle

The launcher performs these operations with argument arrays. It never constructs a shell command.

```text
podman|docker volume create --label io.redline.review-owner=<marker> <review volume>
podman|docker volume create --label io.redline.review-owner=<marker> <source volume>
podman|docker create <staging restrictions> --mount <review volume>:/workspace/review --mount <source volume>:/workspace/source <digest-pinned image>
podman|docker cp <review directory>/. <staging container>:/workspace/review
podman|docker cp <source directory>/. <staging container>:/workspace/source
podman|docker rm --force <staging container>
podman|docker create <runtime restrictions> --mount <volumes readonly> <digest-pinned image>
podman|docker start --attach --interactive <runtime container>
podman|docker rm --force <runtime container>
podman|docker volume rm --force <review volume> <source volume>
```

A read-only root filesystem cannot receive `cp` archives while a container is stopped. The launcher therefore populates two engine-managed named volumes through a never-started staging container, then mounts those volumes read-only in the runtime container. Neither path is a host bind mount, and the backend sees both directories as read-only.

The image reference must end in a lowercase `sha256` digest. Tags are rejected. `src/runner-images.ts` owns the fixed backend-to-digest table. Changes to the table require review; callers cannot override it. The container is created with stdin open because that stream carries the one-time bootstrap envelope when the controller starts it.

The staging container applies these restrictions:

- UID and GID `10001:10001`
- Read-only root filesystem
- No network
- All Linux capabilities dropped
- `no-new-privileges`
- A 64-process limit
- The two review volumes as writable mounts

The runtime container applies these restrictions:

- UID and GID `10001:10001`
- Read-only root filesystem
- All Linux capabilities dropped
- `no-new-privileges`
- A 256-process limit
- A 64 MiB sticky tmpfs at `/tmp/redline`; the bootstrap creates its private runtime directory with mode `0700`
- The review volumes as read-only mounts
- No bind mounts, host directories, devices, privileged mode, or host networking

The container keeps normal network access so the backend can reach the configured model endpoint. Provider destination pinning and general egress restrictions are not implemented in this issue.

The launcher generates every container and volume name plus a unique ownership label. It removes owned resources after normal exit, stop, kill, copy failure, or launch failure. Volume creation is verified through a label-filtered listing before use. If a create is interrupted after the engine may have applied it, the launcher lists containers or volumes by the ownership label and removes only one valid matching name. No match authorizes no removal. Invalid or inconclusive ownership data fails the run instead of removing an unrelated resource.

## Staged data

The stopped container receives two snapshots:

```text
/workspace/review
/workspace/source
```

The first directory contains the bounded review bundle. The second contains the exact head revision prepared as data. Redline does not mount the checkout and does not execute files from either directory. The runtime container mounts both directories read-only.

Prompt assembly continues to validate files through canonical host paths. The model-visible inventory uses only the two container paths above. Optional review files map by fixed names such as `/workspace/review/requirements.md`; prompt assembly does not rewrite host-path prefixes.

## No-tools context and policy contract

The host supplies exact diff text as bounded, length-delimited untrusted JSON. File paths describe provenance, not instructions to open files. Pi and OpenCode cannot read the mounted snapshots because their tools remain disabled. The host includes whole diffs in manifest order. Binary, invalid UTF-8, oversized, and budget-excluded diffs have explicit omission reasons. Findings and reviewed coverage cannot target an omitted diff. Omitted diffs require an incomplete outcome.

Each inline diff is limited to 128 KiB. The evidence and supporting documents share a 512 KiB serialized JSON budget. Supporting text is limited to 32 KiB per file and never displaces an included diff. Unsafe or unavailable optional head/base text, including symlinks and non-regular files, is omitted without reading its target or aborting an otherwise reviewable diff. Authoritative bundle files and diffs still require strict path and regular-file validation. The host reads only manifest-selected head/base files and fixed bundle document names. It does not crawl the checkout. The full untrusted inventory is limited to 1 MiB, and the serialized bootstrap envelope remains limited to 2 MiB. These are byte limits, not model token limits. A provider can still reject a context that exceeds its model's capacity.

Review policy `redline-review/v3` uses this inline evidence. The host loads only fixed versioned policy assets and validated run configuration into the system prompt. Repository text stays in the user message. The bootstrap writes the system prompt to a fixed private tmpfs path for Pi and replaces its default coding system prompt. OpenCode receives a fixed primary review agent with the same policy and deny-all tool permissions. No action input accepts a system prompt, native agent configuration, or a policy file path.

Bootstrap envelope version 2 carries separate `systemPrompt` and `prompt` fields. Version 1 runner images reject this envelope. A rollout therefore needs rebuilt runner images and a reviewed digest-pin update before a live review can use the new contract. The source change alone is not deployment evidence. Tests must exercise the new bootstrap in the exact pinned harness environment before rollout, then the published digest must be verified before the live smoke test.

## Bootstrap channel

A tmpfs does not exist while a container is stopped. Copying credentials before start would write them into the persistent container layer. The runner images therefore start `/opt/redline/bootstrap.js` instead of starting Pi or OpenCode directly.

The host sends one bounded, versioned JSON envelope over the attached stdin stream. It contains:

- The fixed system policy and validated run configuration
- The bounded untrusted review evidence in a separate user prompt
- The validated provider, endpoint, and model
- Only the credential selected for that provider

It never contains the original credential map, `GH_TOKEN`, arbitrary environment values, commands, headers, or native backend configuration.

The bootstrap validates the envelope again. It writes generated configuration with mode `0600` under `/tmp/redline/run`, then launches the fixed absolute backend executable without a shell. The backend receives an allowlisted environment rather than the bootstrap process's ambient environment. The selected credential stays out of process arguments and generated files. The bootstrap gives it to the backend through the fixed `REDLINE_MODEL_CREDENTIAL` environment variable. Pi and OpenCode configuration refer to that variable through their native environment interpolation syntax.

## Pi runtime

The bootstrap creates an empty `settings.json` and a one-provider `models.json`. It invokes the pinned Pi CLI with fixed flags equivalent to:

```text
pi --mode json --no-session --no-tools --no-extensions --no-skills \
  --no-prompt-templates --no-themes --no-context-files \
  --provider <provider> --model <model> --print
```

The user prompt arrives through stdin. The fixed `--system-prompt /tmp/redline/run/pi/review-policy.txt` argument replaces Pi's generic coding policy. The bootstrap generates this private file from the host's fixed policy assets, not from repository content or an action input. Pi cannot load tools, extensions, skills, prompt templates, themes, project instructions, or a saved session.

## OpenCode runtime

The bootstrap creates one OpenCode configuration containing:

- One OpenAI-compatible provider and model
- The fixed Redline report plugin
- A global `"*": "deny"` permission rule

It redirects OpenCode home, cache, data, state, and generated configuration paths to the private tmpfs runtime directory. The bootstrap also creates an empty `node_modules` directory and a fixed lock record for OpenCode's plugin API dependency. The pinned OpenCode version treats that state as complete and does not run its background package installer. The report plugin itself is fixed in the image and has no runtime dependency. The bootstrap also disables project configuration, Claude Code resources, external skills, default plugins, LSP downloads, model-list downloads, and automatic updates. It invokes the pinned CLI as:

```text
opencode run --format json --model <provider>/<model> --title redline-review
```

OpenCode creates its session ID at runtime. The fixed report plugin accepts the first coordinator session, ignores later session IDs, and emits the stable host-visible ID `redline-coordinator`. The host event consumer continues to reject output for any other session ID.

## Controlled native Pi test

The default test suite does not start containers or contact a model. The opt-in native test uses the selected digest-pinned Pi image, inert temporary source data, a fake credential sentinel, and a trusted mock provider in an isolated `network:none` container. The backend shares that container's loopback namespace. It never contacts OpenRouter or GitHub. Production staging, event validation, the journal, and an in-memory publisher remain in the test path.

After the matching image digest is pinned, run:

```bash
REDLINE_TEST_PINNED_PI=1 pnpm test
```

Before the new image is published, the following development-only mode runs the corrected trusted bootstrap from the review volume inside the existing pinned harness image:

```bash
REDLINE_TEST_PINNED_PI=1 REDLINE_TEST_REVIEWED_BOOTSTRAP=1 pnpm test
```

That override tests the proposed bootstrap and real Pi binary. It does not prove the production image contains the corrected bootstrap. The normal test without the override must pass against the published digest before claiming deployment compatibility. The test checks system/user roles, exact diff visibility, no exposed tools, native credential interpolation, validated findings and managed summary publication. It also checks provider failure and token-limit termination after apparent completion, including Pi's zero-exit JSON-mode behavior. Its synthetic responses do not measure live GLM review quality.

## Credential boundaries

Forge credentials remain in host publication code. The staging API has no forge-token input, and none of its engine commands contain a provider credential.

The full `model-credentials` map remains on the host. The staging launcher accepts only the `SelectedModelCredential` returned by `selectDirectModelCredential()`. In the current explicit `direct` mode, that selected value crosses the stdin channel into the container. The planned credential gateway is separate work.
