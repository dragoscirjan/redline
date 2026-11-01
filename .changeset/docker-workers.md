---
"@dragoscirjan/redline": minor
---

Add opt-in Docker isolation for Pi and OpenCode on native Linux amd64 and arm64. Wrap the existing harness binaries in fresh hardened containers, pass only the selected provider credential, and preserve their configuration, parsing and retry behavior. Direct execution remains the default; Redline stays on the host.

Coordinate immutable npm and GHCR artifacts under one package-qualified GitHub Release. Keep incomplete releases as drafts, recover only the original validated artifacts, and require anonymous installed-package and native worker checks before publication is complete.
