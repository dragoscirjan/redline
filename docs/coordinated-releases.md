# Coordinated npm and image releases

One product version identifies the npm CLI and both Docker worker variants. The
implementation lives in `src/release/` and `.github/workflows/npm.release.yml`.
It runs only after the required **main push CI** succeeds. PRs and manual CI dispatches
do not publish. The default workflow token remains read-only; write permissions are
scoped to release/attestation jobs.

This flow applies to new versions only. npm 1.0.0 and 1.1.0 stay unchanged. It does not
create historical GitHub Releases or images for them.

## Owner-controlled version changes

Pending Changesets still go through the pinned Tempel action and an owner-reviewed
version PR. The automation validates that PR but never approves or merges it. Tempel
manages version changes, not the coordinated artifact publication. Its version-only job
receives no npm credential or OIDC write permission, and an unexpected selected mode fails.

After the version PR is merged and all main CI gates pass, the coordinator uses the
version in `package.json`. Ambient `VERSION`, floating image tags and a later source
commit with the same version are not substitutes for that identity.

The npm credential remains the selected `NPM_TOKEN`. The publication child gets a
fresh temporary npm configuration referencing `NODE_AUTH_TOKEN`; it does not inherit
host npm configuration. `id-token: write` supplies provenance, not a replacement npm
authentication policy. Install and publication lifecycle scripts are disabled.

## Candidates before publication

1. Native Linux amd64 and arm64 jobs build Pi and OpenCode from the same clean source,
   pinned Node base, pinned BuildKit, frozen SDK lockfile and exact SDK versions.
2. Both real SDKs execute through the host broker against synthetic loopback models.
   The suite checks findings, RPC, retry quotas, fatal auth, cancellation and kernel
   restrictions. No provider secrets or live models are used.
3. Each OCI candidate's config digest must equal the image config that actually ran.
   Trusted-main GitHub attestations bind the native archive bytes to their source.
4. Assembly creates both exact multi-platform indexes and embeds those index digests
   into the npm candidate. This avoids a circular image/npm dependency: images contain
   the source worker; the npm tarball contains the resolved image identities.
5. The exact npm tarball is installed offline, without scripts or a shared cache.
   Its CLI, committed/worktree echo reviews and acknowledged RPC handshake run outside
   the checkout. A separate trusted-main attestation covers that exact tarball.

Candidate archives and receipts are immutable Actions artifacts retained for 90 days.
The coordinator records their original run and concrete artifact names. Recovery does
not rebuild images, repack npm or silently select a newer main commit.

## Draft until all checks pass

The managed GitHub Release uses a package-qualified tag, for example
`@dragoscirjan/redline@1.2.0`. It does **not** reuse the Action's `vMAJOR.MINOR.PATCH`
or major-alias namespace. The example is a naming convention, not a claim that this
version has already been published.

Before irreversible publication, the coordinator reserves a draft with a machine-readable
immutable identity marker and verifies the expected GitHub Actions author. It attaches:

- The exact npm `.tgz` used for publication.
- `release-manifest.json`: source, version, npm integrity, original candidates, exact
  image index/platform/config digests, SDK versions and base image pin.
- `checksums.json`: checksums for the npm tarball, SBOM and provenance metadata.
- `worker-sbom.spdx.json`: selected SDK npm packages, Node and Debian package inventory.
- `build-provenance.json`: verified native archive attestations, dependency/build pins,
  npm candidate checks and the npm attestation identity.

Image bytes remain in GHCR. Full OCI archives are not GitHub Release attachments.
The SBOM states its coverage: global base-image package-manager dependency closures
are not enumerated, and package.json hashes are not presented as whole-package hashes.
Image digests and the frozen lockfile bind complete runtime content.

Publication checks existing npm integrity and both image version digests before writing
missing artifacts. Conflicting source, tarball, asset, tag or digest identity fails closed;
no version is overwritten or bumped to conceal a failure. Only these two public image
names are managed:

```text
ghcr.io/dragoscirjan/redline-pi
ghcr.io/dragoscirjan/redline-opencode
```

After publication, anonymous verification uses exact npm metadata, fresh empty install
configuration/cache, npm signature/provenance verification, and explicit digest-pinned
image pulls with an empty Docker config. The **public installed CLI** then runs both
real workers on native amd64 and arm64 against the mock endpoint. Both receipts must
match the immutable release identity. Only then can finalization make the draft public.
A metadata no-op is not reported as a fresh successful installed smoke.

## First GHCR publication

The packages must be publicly pullable. A newly created GHCR package may need a one-time
owner visibility change in its package settings. An authenticated push is not proof of
anonymous access. If public verification fails, the release remains a draft even when
npm or images have already been published.

Set both managed packages to public, inspect the failed checks and use the normal
owner-controlled recovery process. Do not publish another npm version, move a tag or
weaken anonymous verification to bypass visibility setup.

## Partial failure and recovery

| Observed state | Behavior |
| --- | --- |
| Exact npm version exists | Verify integrity; do not publish it again |
| Exact image version exists | Verify digest; do not replace it |
| One image is missing | Use the original validated native candidates to publish it |
| Existing identity conflicts | Stop without overwriting the conflicting artifact |
| Registry visibility is delayed | Use bounded readiness checks; retain the draft on failure |
| Installed smoke or native verification fails | Retain the draft; do not count a no-op as a successful smoke |
| Original candidate artifacts expired | Stop; do not reconstruct an unverified replacement |

An npm attempt is checkpointed before the write. If acknowledgement is lost, later
recovery first waits for and verifies the exact existing version. It does not blindly
issue another npm PUT. If the version remains absent, the owner must investigate the
original attempt and registry state before authorizing any checkpoint repair.

A still-missing npm publication requires the original validated main run/source so its
provenance remains accurate. A later main workflow may finish missing images from the
original recorded bytes when npm already exists; it must not invent new npm provenance
for old candidate bytes. Workflow reruns and manual repair remain owner-controlled.

There is no distributed transaction across npm, GHCR and GitHub. A draft can coexist
with already public immutable artifacts. Keep that state visible and recover it;
never claim rollback, overwrite existing artifacts or release a different version as
an error-handling shortcut.
