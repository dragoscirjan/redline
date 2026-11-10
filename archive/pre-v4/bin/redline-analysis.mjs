#!/usr/bin/env node
/** Internal standard-MCP entrypoint; reviewed repository modules are never loaded. */
import { run } from './runtime.mjs';
await run('../src/harness-executor/analysis-server.ts');
