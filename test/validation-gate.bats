#!/usr/bin/env bats

setup() {
  ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
}

@test "validation runs typecheck, vitest and bats tests, and docs in order" {
  run python3 - "$ROOT" <<'PY'
import json
from pathlib import Path
import sys
import tomllib

root = Path(sys.argv[1])
config = tomllib.loads((root / 'mise.toml').read_text())
scripts = json.loads((root / 'package.json').read_text())['scripts']
assert config['tasks']['validate']['run'] == [
    'mise run typecheck', 'mise run test', 'mise run docs',
]
assert scripts['test'].split('&&')[0].strip() == 'pnpm run build'
assert 'vitest run' in scripts['test']
assert 'bats test/*.bats' in scripts['test']
assert scripts['typecheck'].strip() == 'tsc --noEmit -p tsconfig.json'
assert scripts['build'].strip() == 'rm -rf dist && tsc -p tsconfig.json'
PY
  printf '%s\n' "$output"
  [ "$status" -eq 0 ]
}

@test "every Mise task references existing tasks and nonempty package scripts" {
  run python3 - "$ROOT" <<'PY'
import json
from pathlib import Path
import shlex
import sys
import tomllib

root = Path(sys.argv[1])
tasks = tomllib.loads((root / 'mise.toml').read_text())['tasks']
scripts = json.loads((root / 'package.json').read_text())['scripts']
for name, task in tasks.items():
    commands = task['run'] if isinstance(task['run'], list) else [task['run']]
    for command in commands:
        words = shlex.split(command)
        if words[:2] == ['mise', 'run']:
            assert words[2] in tasks, f'{name} references missing task {words[2]}'
        elif words[:2] == ['pnpm', 'run']:
            assert scripts.get(words[2], '').strip(), f'{name} references missing script {words[2]}'
        elif words[:2] == ['pnpm', 'test']:
            assert scripts.get('test', '').strip(), f'{name} references missing test script'
PY
  printf '%s\n' "$output"
  [ "$status" -eq 0 ]
}

@test "Mise pins pnpm 10 consistently with its tool lock" {
  run python3 - "$ROOT" <<'PY'
from pathlib import Path
import re
import sys
import tomllib

root = Path(sys.argv[1])
version = tomllib.loads((root / 'mise.toml').read_text())['tools']['pnpm']
assert re.fullmatch(r'10\.\d+\.\d+', version), 'pnpm must have an exact supported version'
locked = tomllib.loads((root / 'mise.lock').read_text())['tools']['pnpm']
assert len(locked) == 1 and locked[0]['version'] == version
assert 'platforms.linux-x64' in locked[0]
assert 'platforms.linux-arm64' in locked[0]
PY
  printf '%s\n' "$output"
  [ "$status" -eq 0 ]
}

@test "test stack is vitest plus bats and tests only live in test/" {
  run python3 - "$ROOT" <<'PY'
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
package = json.loads((root / 'package.json').read_text())
assert package['devDependencies']['vitest'].startswith('^'), 'vitest must be a pinned dev dependency'
assert package['devDependencies']['bats'].startswith('^'), 'bats must be a pinned dev dependency'
tsconfig = json.loads((root / 'tsconfig.json').read_text())
assert tsconfig['include'] == ['src/**/*.ts', 'test/**/*.ts'], \
    'compiled sources and tests must stay inside src/ and test/'
vitest = (root / 'vitest.config.ts').read_text()
assert "include: ['test/**/*.test.ts']" in vitest, \
    'vitest must only collect test/**/*.test.ts so src.old stays inert'
PY
  printf '%s\n' "$output"
  [ "$status" -eq 0 ]
}

@test "the review CLI is the published bin entry" {
  run python3 - "$ROOT" <<'PY'
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
package = json.loads((root / 'package.json').read_text())
assert package['bin'] == {'redline-review': 'dist/src/review/cli.js'}
assert (root / 'src' / 'review' / 'cli.ts').is_file()
assert (root / 'src' / 'context-bundle.sh').is_file()
PY
  printf '%s\n' "$output"
  [ "$status" -eq 0 ]
}
