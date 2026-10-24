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
assert scripts['test'].strip() == 'vitest run && bats test/*.bats'
assert scripts['typecheck'].strip() == 'tsc --noEmit -p tsconfig.json'
assert 'build' not in scripts
PY
  printf '%s\n' "$output"
  [ "$status" -eq 0 ]
}

@test "CI performance baseline guard includes untracked files" {
  run python3 - "$ROOT" <<'PY'
from pathlib import Path
import sys

root = Path(sys.argv[1])
ci = (root / '.github' / 'workflows' / 'ci.yml').read_text()
assert 'git status --porcelain --untracked-files=all -- benchmark/performance/v1/baseline' in ci, \
    'the deterministic baseline guard must detect new and renamed files'
assert 'performance baseline changed:' in ci, \
    'baseline drift must produce an explicit CI diagnostic'
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

@test "Mise pins pnpm and Bun consistently with its tool lock" {
  run python3 - "$ROOT" <<'PY'
from pathlib import Path
import re
import sys
import tomllib

root = Path(sys.argv[1])
tools = tomllib.loads((root / 'mise.toml').read_text())['tools']
pnpm_version = tools['pnpm']
assert re.fullmatch(r'10\.\d+\.\d+', pnpm_version), 'pnpm must have an exact supported version'
assert tools['node'] == '24'
assert tools['bun'] == '1.4.4'
lock = tomllib.loads((root / 'mise.lock').read_text())['tools']
locked_pnpm = lock['pnpm']
assert len(locked_pnpm) == 1 and locked_pnpm[0]['version'] == pnpm_version
assert 'platforms.linux-x64' in locked_pnpm[0]
assert 'platforms.linux-arm64' in locked_pnpm[0]
locked_bun = lock['bun']
assert len(locked_bun) == 1 and locked_bun[0]['version'] == tools['bun']
assert 'platforms.linux-x64' in locked_bun[0]
assert 'platforms.linux-arm64' in locked_bun[0]
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
    'maintained sources and tests must stay inside src/ and test/'
assert tsconfig['compilerOptions']['noEmit'] is True
assert tsconfig['compilerOptions']['erasableSyntaxOnly'] is True
assert tsconfig['compilerOptions']['allowImportingTsExtensions'] is True
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
import os
from pathlib import Path
import sys

root = Path(sys.argv[1])
package = json.loads((root / 'package.json').read_text())
assert package['bin'] == {'redline-review': 'src/review/cli.ts'}
assert (root / 'src' / 'review' / 'cli.ts').is_file()
assert os.access(root / 'src' / 'review' / 'cli.ts', os.X_OK)
assert (root / 'src' / 'context-bundle.ts').is_file()
PY
  printf '%s\n' "$output"
  [ "$status" -eq 0 ]
}
