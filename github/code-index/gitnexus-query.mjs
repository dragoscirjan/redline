#!/usr/bin/env node

import { lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [moduleRoot, repository, query, ...extra] = process.argv.slice(2);
if (extra.length > 0 || !moduleRoot || !repository || !query) {
  throw new Error('expected module root, repository path, and bounded query');
}
if (!isAbsolute(moduleRoot) || !isAbsolute(repository)) {
  throw new Error('GitNexus module root and repository must be absolute paths');
}
const backendModule = join(moduleRoot, 'dist', 'mcp', 'local', 'local-backend.js');
const info = await lstat(backendModule);
if (!info.isFile() || info.isSymbolicLink()) {
  throw new Error('GitNexus local backend is not a regular file');
}
const { LocalBackend } = await import(pathToFileURL(backendModule).href);
const backend = new LocalBackend();
const rows = await backend.executeCypher(repository, query);
if (!Array.isArray(rows)) {
  throw new Error('GitNexus query did not return row data');
}
process.stdout.write(`${JSON.stringify(rows, (_key, value) => {
  if (typeof value === 'bigint') {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new Error('GitNexus returned an unsafe integer');
    return number;
  }
  return value;
})}\n`);
