#!/usr/bin/env bats

setup() {
  ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  ACTION_DIR="$ROOT/github/code-index"
  TMP_ROOT=$(mktemp -d)
  REPOSITORY="$TMP_ROOT/repository"
  PROVIDER="$TMP_ROOT/provider"
  mkdir -p "$REPOSITORY/src" "$PROVIDER"
  cp "$ROOT/test/fixtures/code-index/fake-cgc.sh" "$PROVIDER/cgc"
  chmod 0755 "$PROVIDER/cgc"
  GITNEXUS_PROVIDER="$TMP_ROOT/gitnexus-provider"
  mkdir -p "$GITNEXUS_PROVIDER/dist/cli" "$GITNEXUS_PROVIDER/dist/mcp/local"
  cp "$ROOT/test/fixtures/code-index/fake-gitnexus-cli.js" "$GITNEXUS_PROVIDER/dist/cli/index.js"
  cp "$ROOT/test/fixtures/code-index/fake-gitnexus-local-backend.js" "$GITNEXUS_PROVIDER/dist/mcp/local/local-backend.js"

  git -C "$REPOSITORY" init -q -b main
  git -C "$REPOSITORY" config user.name redline-test
  git -C "$REPOSITORY" config user.email redline@example.invalid
  cat > "$REPOSITORY/src/cache.ts" <<'EOF'
export function userCacheKey(accountId: string, userId: string): string {
  return `${accountId}:${userId}`;
}
EOF
  cat > "$REPOSITORY/src/user-service.ts" <<'EOF'
import { userCacheKey } from './cache.js';

export function loadUser(accountId: string, userId: string): string {
  return userCacheKey(accountId, userId);
}
EOF
  git -C "$REPOSITORY" add .
  git -C "$REPOSITORY" commit -q -m base
  BASE=$(git -C "$REPOSITORY" rev-parse HEAD)
  cat > "$REPOSITORY/src/cache.ts" <<'EOF'
export function userCacheKey(accountId: string, userId: string): string {
  return userId;
}
EOF
  git -C "$REPOSITORY" add .
  git -C "$REPOSITORY" commit -q -m head
  HEAD_REVISION=$(git -C "$REPOSITORY" rev-parse HEAD)

  export RUNNER_TEMP="$TMP_ROOT/runtime"
  GITNEXUS_CONTROL="$RUNNER_TEMP/fake-gitnexus-control"
  mkdir -p "$GITNEXUS_CONTROL"
  export RUNNER_OS=Linux
  export RUNNER_ARCH=X64
  export GITHUB_WORKSPACE="$REPOSITORY"
  export GITHUB_RUN_ID=123
  export GITHUB_RUN_ATTEMPT=1
  export REDLINE_CODE_INDEX_PROVIDER=cgc
  export REDLINE_CODE_INDEX_BASE="$BASE"
  export REDLINE_CODE_INDEX_HEAD="$HEAD_REVISION"
  export REDLINE_CODE_INDEX_REPOSITORY='owner/repository'
  export REDLINE_CODE_INDEX_OUTPUT_DIRECTORY="$REPOSITORY/code-index-output"
  export REDLINE_CGC_EXECUTABLE="$PROVIDER/cgc"
  export GITHUB_OUTPUT="$TMP_ROOT/github-output"
  : > "$GITHUB_OUTPUT"
}

teardown() {
  rm -rf "$TMP_ROOT"
}

write_relationship_fixture() {
  python3 - "$PROVIDER/results-incoming.json" "$RUNNER_TEMP/redline-code-index/source" <<'PY'
import json, os, sys
output, root = sys.argv[1:]
rows = [{
    'changed_path': os.path.join(root, 'src/cache.ts'),
    'related_path': os.path.join(root, 'src/user-service.ts'),
    'start_line': 3,
    'end_line': 5,
}]
with open(output, 'w', encoding='utf-8') as handle:
    json.dump(rows, handle)
    handle.write('\n')
PY
}

prepare_action() {
  run bash "$ACTION_DIR/run.sh" prepare
  [ "$status" -eq 0 ]
  grep -Fq 'available=true' "$GITHUB_OUTPUT"
  if [[ "$REDLINE_CODE_INDEX_PROVIDER" == 'cgc' ]]; then
    write_relationship_fixture
  fi
}

build_action() {
  export REDLINE_CODE_INDEX_CACHE_MATCHED_KEY="${1:-}"
  export REDLINE_CODE_INDEX_CACHE_RESTORE_OUTCOME="${2:-success}"
  : > "$GITHUB_OUTPUT"
  run bash "$ACTION_DIR/run.sh" build
  [ "$status" -eq 0 ]
}

@test "secondary action pins CGC and actions/cache without provider configuration inputs" {
  if ! python3 -c 'import yaml' 2>/dev/null; then
    skip 'PyYAML is required to validate action.yaml'
  fi
  python3 - "$ACTION_DIR/action.yaml" <<'PY'
import sys
from pathlib import Path
import yaml
action = yaml.safe_load(Path(sys.argv[1]).read_text())
assert set(action['inputs']) == {'provider', 'base', 'head', 'repository', 'output-directory'}
assert action['inputs']['provider']['default'] == 'cgc'
steps = action['runs']['steps']
uses = [step.get('uses') for step in steps]
sha = 'cdf6c1fa76f9f475f3d7449005a359c84ca0f306'
assert f'actions/cache/restore@{sha}' in uses
assert f'actions/cache/save@{sha}' in uses
restore = next(step for step in steps if step.get('id') == 'cache-restore')
assert restore['with']['restore-keys'].strip() == '${{ steps.prepare.outputs.cache-base-prefix }}'
assert 'cache-exact-prefix' not in restore['with']['restore-keys']
assert 'cache-compatible-prefix' not in restore['with']['restore-keys']
assert action['outputs']['context-file']['value'] == '${{ steps.finalize.outputs.context-file }}'
PY
}

@test "cold and restored-base fake-CGC runs export equivalent validated context" {
  prepare_action
  grep -Fq -- "-$BASE-123-1" "$GITHUB_OUTPUT"
  grep -Fq -- "-$BASE-" "$GITHUB_OUTPUT"
  ! grep -Fq -- "-$HEAD_REVISION-" "$GITHUB_OUTPUT"
  build_action '' success
  grep -Fq 'cache-ready=true' "$GITHUB_OUTPUT"
  run bash "$ACTION_DIR/run.sh" save-start
  [ "$status" -eq 0 ]
  export REDLINE_CODE_INDEX_CACHE_SAVE_OUTCOME=failure
  run bash "$ACTION_DIR/run.sh" finalize
  [ "$status" -eq 0 ]
  cp "$REDLINE_CODE_INDEX_OUTPUT_DIRECTORY/code-context.json" "$TMP_ROOT/cold.json"

  : > "$PROVIDER/calls.log"
  build_action 'redline-code-index-compatible-cache' success
  grep -Fq 'cache-ready=false' "$GITHUB_OUTPUT"
  ! grep -Eq '^(index|update) ' "$PROVIDER/calls.log"
  cp "$REDLINE_CODE_INDEX_OUTPUT_DIRECTORY/code-context.json" "$TMP_ROOT/warm.json"

  python3 - "$TMP_ROOT/cold.json" "$TMP_ROOT/warm.json" "$HEAD_REVISION" <<'PY'
import json, sys
cold = json.load(open(sys.argv[1], encoding='utf-8'))
warm = json.load(open(sys.argv[2], encoding='utf-8'))
assert cold['version'] == 1
assert cold['provider'] == {'id': 'cgc', 'version': '0.5.7'}
assert cold['revision'] == sys.argv[3]
assert cold['status'] == warm['status'] == 'complete'
assert cold['files'] == warm['files']
assert isinstance(cold['timings']['saveMs'], int)
assert warm['timings']['indexMs'] == 0
assert any(item['code'] == 'cache-save-failed' for item in cold['diagnostics'])
assert cold['files'][0]['related'] == [{
    'path': 'src/user-service.ts',
    'startLine': 3,
    'endLine': 5,
    'reason': 'related-symbol-calls-changed-code',
}]
assert any(item['code'] == 'cache-base-revision' for item in warm['diagnostics'])
PY
}

@test "the base cache is reused without re-indexing after a new head commit" {
  prepare_action
  build_action '' success
  cached_revision="$BASE"

  cat > "$REPOSITORY/src/cache.ts" <<'EOF'
export function userCacheKey(accountId: string, userId: string): string {
  return `${userId}:${accountId}`;
}
EOF
  git -C "$REPOSITORY" add src/cache.ts
  git -C "$REPOSITORY" commit -q -m follow-up
  HEAD_REVISION=$(git -C "$REPOSITORY" rev-parse HEAD)
  export REDLINE_CODE_INDEX_HEAD="$HEAD_REVISION"
  : > "$PROVIDER/calls.log"

  build_action 'redline-code-index-earlier-head-cache' success

  grep -Fq 'cache-ready=false' "$GITHUB_OUTPUT"
  ! grep -Eq '^(index|update) ' "$PROVIDER/calls.log"
  python3 - "$REDLINE_CODE_INDEX_OUTPUT_DIRECTORY/code-context.json" "$RUNNER_TEMP/redline-code-index/cache/state.json" "$cached_revision" "$HEAD_REVISION" <<'PY'
import json, sys
artifact = json.load(open(sys.argv[1], encoding='utf-8'))
state = json.load(open(sys.argv[2], encoding='utf-8'))
assert artifact['revision'] == sys.argv[4]
assert artifact['status'] == 'complete'
assert artifact['files'][0]['status'] == 'complete'
assert artifact['timings']['indexMs'] == 0
assert any(item['code'] == 'graph-base-revision' for item in artifact['diagnostics'])
assert any(item['code'] == 'cache-base-revision' for item in artifact['diagnostics'])
assert state['revision'] == sys.argv[3]
PY
}

@test "an invalid restored database is deleted and rebuilt once" {
  prepare_action
  outside="$TMP_ROOT/outside-cache-target"
  mkdir -p "$outside"
  printf 'keep\n' > "$outside/marker"
  rm -rf "$RUNNER_TEMP/redline-code-index/cache/database"
  ln -s "$outside" "$RUNNER_TEMP/redline-code-index/cache/database"
  printf '{"version":0}\n' > "$RUNNER_TEMP/redline-code-index/cache/state.json"
  : > "$PROVIDER/calls.log"

  build_action 'redline-code-index-invalid-cache' success
  grep -Fq 'index ' "$PROVIDER/calls.log"
  count=$(grep -c '^index ' "$PROVIDER/calls.log")
  [ "$count" -eq 1 ]
  [ -f "$outside/marker" ]
  [ ! -L "$RUNNER_TEMP/redline-code-index/cache/database" ]
  python3 - "$REDLINE_CODE_INDEX_OUTPUT_DIRECTORY/code-context.json" <<'PY'
import json, sys
artifact = json.load(open(sys.argv[1], encoding='utf-8'))
assert artifact['status'] == 'complete'
assert any(item['code'] == 'cache-restore-invalid' for item in artifact['diagnostics'])
PY
}

@test "provider failure writes unavailable context and keeps the action successful" {
  prepare_action
  printf 'index-fail\n' > "$PROVIDER/mode"
  build_action '' success
  grep -Fq 'cache-ready=false' "$GITHUB_OUTPUT"
  python3 - "$REDLINE_CODE_INDEX_OUTPUT_DIRECTORY/code-context.json" <<'PY'
import json, sys
artifact = json.load(open(sys.argv[1], encoding='utf-8'))
assert artifact['status'] == 'unavailable'
assert artifact['files'][0]['status'] == 'unavailable'
assert any(item['code'] == 'cgc-index-failed' for item in artifact['diagnostics'])
PY
}

@test "finalize propagates exporter failures" {
  prepare_action
  printf 'not-json\n' > "$REDLINE_CODE_INDEX_OUTPUT_DIRECTORY/code-context.json"
  : > "$GITHUB_OUTPUT"

  run bash "$ACTION_DIR/run.sh" finalize

  [ "$status" -ne 0 ]
  ! grep -Fq 'context-file=' "$GITHUB_OUTPUT"
  ! grep -Fq 'status=' "$GITHUB_OUTPUT"
}

@test "unsupported changed files still build a reusable base-revision repository cache" {
  git -C "$REPOSITORY" reset -q --hard "$BASE"
  mkdir -p "$REPOSITORY/.github/workflows"
  printf 'name: cache-test\n' > "$REPOSITORY/.github/workflows/cache-test.yml"
  git -C "$REPOSITORY" add .github/workflows/cache-test.yml
  git -C "$REPOSITORY" commit -q -m yaml-only-head
  HEAD_REVISION=$(git -C "$REPOSITORY" rev-parse HEAD)
  export REDLINE_CODE_INDEX_HEAD="$HEAD_REVISION"

  prepare_action
  : > "$PROVIDER/calls.log"
  build_action '' success

  grep -Fq 'cache-ready=true' "$GITHUB_OUTPUT"
  grep -Fq "index $RUNNER_TEMP/redline-code-index/source --no-progress" "$PROVIDER/calls.log"
  [ -f "$RUNNER_TEMP/redline-code-index/cache/state.json" ]
  python3 - "$REDLINE_CODE_INDEX_OUTPUT_DIRECTORY/code-context.json" "$RUNNER_TEMP/redline-code-index/cache/state.json" "$BASE" <<'PY'
import json, sys
artifact = json.load(open(sys.argv[1], encoding='utf-8'))
state = json.load(open(sys.argv[2], encoding='utf-8'))
assert artifact['status'] == 'unsupported'
assert artifact['files'] == [{
    'changedPath': '.github/workflows/cache-test.yml',
    'status': 'unsupported',
    'related': [],
}]
assert any(item['code'] == 'no-supported-changed-files' for item in artifact['diagnostics'])
assert artifact['timings']['indexMs'] >= 0
assert state['revision'] == sys.argv[3]
PY
}

@test "cold and restored-base fake-GitNexus runs reuse the validated graph" {
  export REDLINE_CODE_INDEX_PROVIDER=gitnexus
  export REDLINE_GITNEXUS_EXECUTABLE="$GITNEXUS_PROVIDER/dist/cli/index.js"
  export REDLINE_GITNEXUS_RUNTIME
  REDLINE_GITNEXUS_RUNTIME=$(command -v node)
  unset REDLINE_CGC_EXECUTABLE

  prepare_action
  grep -Fq 'redline-code-index-v2-gitnexus-1.6.12-linux-x64-' "$GITHUB_OUTPUT"
  build_action '' success
  grep -Fq 'cache-ready=true' "$GITHUB_OUTPUT"
  grep -Fq "analyze $RUNNER_TEMP/redline-code-index/source --index-only --skip-git --skip-fts --workers 2" "$GITNEXUS_CONTROL/calls.log"
  cp "$REDLINE_CODE_INDEX_OUTPUT_DIRECTORY/code-context.json" "$TMP_ROOT/gitnexus-cold.json"

  : > "$GITNEXUS_CONTROL/calls.log"
  build_action 'redline-code-index-gitnexus-base-cache' success
  grep -Fq 'cache-ready=false' "$GITHUB_OUTPUT"
  ! grep -q '^analyze ' "$GITNEXUS_CONTROL/calls.log"
  cp "$REDLINE_CODE_INDEX_OUTPUT_DIRECTORY/code-context.json" "$TMP_ROOT/gitnexus-warm.json"

  python3 - "$TMP_ROOT/gitnexus-cold.json" "$TMP_ROOT/gitnexus-warm.json" "$HEAD_REVISION" <<'PY'
import json, sys
cold = json.load(open(sys.argv[1], encoding='utf-8'))
warm = json.load(open(sys.argv[2], encoding='utf-8'))
assert cold['provider'] == {'id': 'gitnexus', 'version': '1.6.12'}
assert cold['revision'] == sys.argv[3]
assert cold['status'] == warm['status'] == 'complete'
assert cold['files'] == warm['files']
assert warm['timings']['indexMs'] == 0
assert cold['files'][0]['related'] == [{
    'path': 'src/user-service.ts',
    'startLine': 3,
    'endLine': 5,
    'reason': 'related-symbol-calls-changed-code',
}]
assert any(item['code'] == 'cache-base-revision' for item in warm['diagnostics'])
PY
}

@test "fake-GitNexus invalid caches rebuild and relationship failures degrade" {
  export REDLINE_CODE_INDEX_PROVIDER=gitnexus
  export REDLINE_GITNEXUS_EXECUTABLE="$GITNEXUS_PROVIDER/dist/cli/index.js"
  export REDLINE_GITNEXUS_RUNTIME
  REDLINE_GITNEXUS_RUNTIME=$(command -v node)
  unset REDLINE_CGC_EXECUTABLE

  prepare_action
  build_action '' success
  outside="$TMP_ROOT/gitnexus-outside-cache-target"
  mkdir -p "$outside"
  printf 'keep\n' > "$outside/marker"
  rm -rf "$RUNNER_TEMP/redline-code-index/cache/database"
  ln -s "$outside" "$RUNNER_TEMP/redline-code-index/cache/database"
  : > "$GITNEXUS_CONTROL/calls.log"

  build_action 'redline-code-index-invalid-gitnexus-cache' success
  [ "$(grep -c '^analyze ' "$GITNEXUS_CONTROL/calls.log")" -eq 1 ]
  [ -f "$outside/marker" ]
  [ ! -L "$RUNNER_TEMP/redline-code-index/cache/database" ]

  printf 'query-fail\n' > "$GITNEXUS_CONTROL/mode"
  : > "$GITNEXUS_CONTROL/calls.log"
  build_action 'redline-code-index-valid-gitnexus-cache' success
  grep -Fq 'cache-ready=false' "$GITHUB_OUTPUT"
  ! grep -q '^analyze ' "$GITNEXUS_CONTROL/calls.log"
  python3 - "$REDLINE_CODE_INDEX_OUTPUT_DIRECTORY/code-context.json" <<'PY'
import json, sys
artifact = json.load(open(sys.argv[1], encoding='utf-8'))
assert artifact['provider'] == {'id': 'gitnexus', 'version': '1.6.12'}
assert artifact['status'] == 'unavailable'
codes = {item['code'] for item in artifact['diagnostics']}
assert {'gitnexus-outgoing-query-failed', 'gitnexus-incoming-query-failed'} <= codes
PY
}

@test "live pinned GitNexus smoke test is opt-in" {
  [[ "${REDLINE_LIVE_GITNEXUS_TESTS:-0}" == '1' ]] || skip 'set REDLINE_LIVE_GITNEXUS_TESTS=1 to run the live GitNexus smoke test'
  export REDLINE_CODE_INDEX_PROVIDER=gitnexus
  unset REDLINE_GITNEXUS_EXECUTABLE REDLINE_GITNEXUS_RUNTIME REDLINE_CGC_EXECUTABLE
  : > "$GITHUB_OUTPUT"
  run bash "$ACTION_DIR/run.sh" prepare
  [ "$status" -eq 0 ]
  grep -Fq 'available=true' "$GITHUB_OUTPUT"
  build_action '' success
  cp "$REDLINE_CODE_INDEX_OUTPUT_DIRECTORY/code-context.json" "$TMP_ROOT/live-gitnexus-cold.json"
  build_action 'redline-code-index-live-gitnexus-base-cache' success
  grep -Fq 'cache-ready=false' "$GITHUB_OUTPUT"
  python3 - "$TMP_ROOT/live-gitnexus-cold.json" "$REDLINE_CODE_INDEX_OUTPUT_DIRECTORY/code-context.json" <<'PY'
import json, sys
cold = json.load(open(sys.argv[1], encoding='utf-8'))
warm = json.load(open(sys.argv[2], encoding='utf-8'))
print(json.dumps({'cold': cold, 'warm': warm}, sort_keys=True))
assert cold['provider'] == warm['provider'] == {'id': 'gitnexus', 'version': '1.6.12'}
assert cold['status'] == warm['status'] == 'complete'
assert cold['files'] == warm['files']
assert cold['timings']['indexMs'] >= 0
assert warm['timings']['indexMs'] == 0
assert any(item['code'] == 'cache-base-revision' for item in warm['diagnostics'])
PY
}

@test "live pinned CGC smoke test is opt-in" {
  [[ "${REDLINE_LIVE_CODE_INDEX_TESTS:-0}" == '1' ]] || skip 'set REDLINE_LIVE_CODE_INDEX_TESTS=1 to run the live pinned-provider smoke test'
  unset REDLINE_CGC_EXECUTABLE
  : > "$GITHUB_OUTPUT"
  run bash "$ACTION_DIR/run.sh" prepare
  [ "$status" -eq 0 ]
  grep -Fq 'available=true' "$GITHUB_OUTPUT"
  build_action '' success
  python3 - "$REDLINE_CODE_INDEX_OUTPUT_DIRECTORY/code-context.json" <<'PY'
import json, sys
artifact = json.load(open(sys.argv[1], encoding='utf-8'))
print(json.dumps(artifact, sort_keys=True))
assert artifact['provider'] == {'id': 'cgc', 'version': '0.5.7'}
assert artifact['status'] == 'complete'
assert artifact['files'][0]['related'] == [{
    'path': 'src/user-service.ts',
    'startLine': 3,
    'endLine': 5,
    'reason': 'related-symbol-calls-changed-code',
}]
timings = artifact['timings']
for key in ('installationMs', 'restoreMs', 'indexMs', 'queryMs'):
    assert isinstance(timings[key], int) and timings[key] >= 0
assert timings['saveMs'] is None or isinstance(timings['saveMs'], int)
print(json.dumps({
    'provider': artifact['provider'],
    'status': artifact['status'],
    'related': artifact['files'][0]['related'],
    'timings': timings,
}, sort_keys=True))
PY
}
