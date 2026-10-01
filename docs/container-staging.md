# Container staging

Redline prepares each review container through `createContainerStagingLauncher()` in `src/container-staging.ts`. The launcher creates and populates the container only after the host has validated the review bundle and assembled the trusted prompt.

The GitHub Action does not call this launcher yet. Issue #21 owns that wiring.

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

The image reference must end in a lowercase `sha256` digest. Tags are rejected. Issue #23 will own the released backend-to-digest table. The container is created with stdin open because that stream carries the one-time bootstrap envelope when the controller starts it.

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

## Bootstrap channel

A tmpfs does not exist while a container is stopped. Copying credentials before start would write them into the persistent container layer. The runner images therefore start `/opt/redline/bootstrap.js` instead of starting Pi or OpenCode directly.

The host sends one bounded, versioned JSON envelope over the attached stdin stream. It contains:

- The trusted prompt
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

The prompt arrives through stdin. Pi cannot load tools, extensions, skills, prompt templates, themes, project instructions, or a saved session.

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

## Credential boundaries

Forge credentials remain in host publication code. The staging API has no forge-token input, and none of its engine commands contain a provider credential.

The full `model-credentials` map remains on the host. The staging launcher accepts only the `SelectedModelCredential` returned by `selectDirectModelCredential()`. In the current explicit `direct` mode, that selected value crosses the stdin channel into the container. The planned credential gateway is separate work.
