#!/usr/bin/env node
import { run } from './runtime.mjs';
await run(process.argv[2] === 'rpc' ? '../src/rpc/main.ts' : '../src/local/cli.ts');
