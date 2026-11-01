---
"@dragoscirjan/redline": minor
---

Add a Docker image that runs Redline with Node, Bun, Python, Pi, OpenCode and the requested MCP dependencies. Keep the existing CLI and native harness execution unchanged; Docker is invoked externally with read-only repository and writable output/cache mounts.

Respect XDG_CACHE_HOME for persistent provider indexes, and build and publish the image through a standard GHCR workflow only after a successful new npm publication, with the matching package version tag.
