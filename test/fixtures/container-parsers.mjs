import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';

const require = createRequire(realpathSync('/opt/harness/node_modules/gitnexus/package.json'));
const { dependencies } = require('./package.json');
const loaded = Object.keys(dependencies).filter(name => name === 'tree-sitter' || name.startsWith('tree-sitter-')).sort();
for (const name of loaded) require(name);
const Parser = require('tree-sitter');
const parser = new Parser();
parser.setLanguage(require('tree-sitter-typescript').typescript);
const tree = parser.parse('export const value = 1;');
console.log(JSON.stringify({ arch: process.arch, loaded, root: tree.rootNode.type, hasError: tree.rootNode.hasError }));
