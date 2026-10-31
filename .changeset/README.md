# Versioning

Releases run automatically after successful main CI. No separate release workflow dispatch is required.

For a user-visible change, run `pnpm exec changeset` on the development branch and commit the generated note. After that change merges, Tempel opens or updates a version pull request. Review and merge that PR to publish the new version after CI passes. Do not edit package versions by hand or merge the version PR automatically.

The first unpublished manifest version can publish without a version PR. If the version is already published and no notes remain, release is a no-op. The publication hook still requires consumed notes and an available immutable version.

See [release operations](../docs/local-cli.md#release-operations) for token setup and verification.
