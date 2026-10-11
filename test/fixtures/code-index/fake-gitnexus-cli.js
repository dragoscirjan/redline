#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const control = path.resolve(__dirname, '..', '..');
const modePath = path.join(control, 'mode');
const mode = fs.existsSync(modePath) ? fs.readFileSync(modePath, 'utf8').trim() : 'ok';
fs.appendFileSync(path.join(control, 'calls.log'), `${process.argv.slice(2).join(' ')}\n`);

if (process.argv[2] === '--version') {
  process.stdout.write('1.6.12\n');
  process.exit(0);
}
if (process.argv[2] !== 'analyze') process.exit(25);
if (mode === 'index-fail') process.exit(21);
const storage = process.env.GITNEXUS_STORAGE_PATH;
const home = process.env.GITNEXUS_HOME;
if (!storage || !home) process.exit(22);
fs.mkdirSync(storage, { recursive: true });
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(storage, 'valid'), 'ok\n');
fs.writeFileSync(path.join(home, 'registry.json'), '{}\n');
