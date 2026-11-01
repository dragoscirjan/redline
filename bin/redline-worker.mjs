#!/usr/bin/env node
// Private image entry point. It is not registered as an npm command.
import { run } from './runtime.mjs';
await run('../src/harness-worker/worker.ts');
