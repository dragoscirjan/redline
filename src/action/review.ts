#!/usr/bin/env node
/** Trusted composite-action entry point. Host-managed indexing and follow-up queries are retired. */
import { pathToFileURL } from 'node:url';
import { main } from '../review/cli.ts';

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then((code) => { process.exitCode = code; }).catch(() => {
    process.stderr.write('redline-review: review unavailable\n');
    process.exitCode = 1;
  });
}
