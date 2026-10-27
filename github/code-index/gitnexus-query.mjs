#!/usr/bin/env node
// Compatibility entrypoint; provider queries are shared with the local CLI.
await import(new URL('../../src/code-index/gitnexus-query.mjs', import.meta.url));
