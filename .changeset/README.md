# Versioning

The protected npm workflow publishes the reviewed version in `package.json`. It does not create version pull requests or publish automatically after a merge.

For a future release, use `pnpm exec changeset` and `pnpm exec changeset version` on a development branch. Commit the resulting manifest and changelog changes for review. Consume every pending Changeset before requesting publication. The release preflight rejects pending notes, prerelease state and unexpected files here, so the shared action cannot enter version mode.

See [release operations](../docs/local-cli.md#release-operations) for approval, token setup and verification.
