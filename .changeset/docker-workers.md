---
"@dragoscirjan/redline": minor
---

Add opt-in Docker isolation for Pi and OpenCode on native Linux amd64 and arm64. Wrap the existing harness binaries in fresh hardened containers, pass only the selected provider credential, and preserve their configuration, parsing and retry behavior. Direct execution remains the default; Redline stays on the host.

Use one shared Node/Bun image, built and published by a standard GHCR workflow independently of npm releases. Select the trusted image explicitly; no coordinated release system or custom image manifest is required.
