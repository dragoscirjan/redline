'use strict';

const fs = require('node:fs');
const path = require('node:path');

const control = path.resolve(__dirname, '..', '..', '..');

class LocalBackend {
  async executeCypher(_repository, query) {
    fs.appendFileSync(path.join(control, 'calls.log'), `query ${query}\n`);
    const modePath = path.join(control, 'mode');
    const mode = fs.existsSync(modePath) ? fs.readFileSync(modePath, 'utf8').trim() : 'ok';
    const storage = process.env.GITNEXUS_STORAGE_PATH;
    if (!storage || !fs.existsSync(path.join(storage, 'valid'))) {
      throw new Error('database unavailable');
    }
    if (query.includes('node_count')) return [{ node_count: 2 }];
    if (mode === 'query-fail') throw new Error('controlled query failure');
    if (query.startsWith('MATCH (changed)')) return [];
    return [{
      changed_path: 'src/cache.ts',
      related_path: 'src/user-service.ts',
      start_line: 3,
      end_line: 5,
    }];
  }
}

module.exports = { LocalBackend };
