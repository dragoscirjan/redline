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
  export REDLINE_CODE_INDEX_MODE=review
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

write_follow_up_fixture() {
  mkdir -p "$TMP_ROOT/review"
  python3 - "$TMP_ROOT/review/manifest.json" "$TMP_ROOT/requests.json" "$BASE" "$HEAD_REVISION" <<'PY'
import hashlib, json, sys
manifest, requests, base, head = sys.argv[1:]
with open(manifest, 'w', encoding='utf-8') as handle:
    json.dump({'version': 1, 'base': base, 'head': head, 'files': [{
        'id': '000001', 'reviewed': True, 'newPath': 'src/cache.ts', 'oldPath': 'src/cache.ts'
    }]}, handle)
candidate = 'f-' + 'b'*24
identity = ['owner/repository', base, head, '000001', candidate, 'src/cache.ts', 'incoming']
identifier = 'related-span:sha256:' + hashlib.sha256(json.dumps(identity,
    ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest()
with open(requests, 'w', encoding='utf-8') as handle:
    json.dump({'version': 1, 'repository': 'owner/repository', 'base': base, 'head': head,
        'omitted': 0, 'requests': [{
            'id': identifier, 'candidateId': candidate, 'fileId': '000001',
            'changedPath': 'src/cache.ts', 'capability': 'related-spans',
            'direction': 'incoming', 'depth': 1, 'fanOut': 8, 'resultLimit': 8,
        }]}, handle)
PY
}

assert_complete_follow_up() {
  python3 - "$TMP_ROOT/result.json" "$HEAD_REVISION" "$BASE" "$1" <<'PY'
import json, sys
result = json.load(open(sys.argv[1], encoding='utf-8'))
assert result['head'] == sys.argv[2] and result['base'] == result['snapshot'] == sys.argv[3]
assert result['provider']['id'] == sys.argv[4]
assert result['results'][0]['status'] == 'complete', result
assert result['results'][0]['spans'] == [{
    'path': 'src/user-service.ts', 'revision': sys.argv[2], 'startLine': 3,
    'endLine': 5, 'evidence': "export function loadUser(accountId: string, userId: string): string {",
    'relationship': 'related-symbol-calls-changed-code',
}], result
PY
}

run_follow_up_worker() {
  python3 "$ACTION_DIR/follow-up.py" --provider "$1" --repository owner/repository \
    --base "$BASE" --head "$HEAD_REVISION" --review-dir "$TMP_ROOT/review" \
    --runner-temp "$RUNNER_TEMP" --input "$TMP_ROOT/requests.json" --output "$TMP_ROOT/result.json"
}

benchmark_follow_up() {
  local provider=$1 durations="$TMP_ROOT/follow-up-durations.txt" sample
  : > "$durations"
  for sample in 1 2 3 4 5; do
    run run_follow_up_worker "$provider"
    [ "$status" -eq 0 ]
    assert_complete_follow_up "$provider"
    python3 - "$TMP_ROOT/result.json" >> "$durations" <<'PY'
import json, sys
print(json.load(open(sys.argv[1], encoding='utf-8'))['results'][0]['durationMs'])
PY
  done
  python3 - "$REDLINE_CODE_INDEX_OUTPUT_DIRECTORY/code-context.json" "$TMP_ROOT/result.json" "$durations" <<'PY'
import json, math, statistics, sys
artifact = json.load(open(sys.argv[1], encoding='utf-8'))
exchange = json.load(open(sys.argv[2], encoding='utf-8'))
durations = sorted(int(value) for value in open(sys.argv[3], encoding='utf-8') if value.strip())
result = exchange['results'][0]
print(json.dumps({
    'provider': artifact['provider'],
    'artifactStatus': artifact['status'],
    'capability': 'related-spans',
    'followUpStatus': result['status'],
    'spanCount': len(result['spans']),
    'indexTimings': artifact['timings'],
    'followUpLatencyMs': {
        'samples': durations,
        'median': statistics.median(durations),
        'p95NearestRank': durations[math.ceil(0.95 * len(durations)) - 1],
    },
}, sort_keys=True))
PY
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
assert set(action['inputs']) == {'provider', 'mode', 'base', 'head', 'repository', 'output-directory'}
assert action['inputs']['provider']['default'] == 'cgc'
assert action['inputs']['mode']['default'] == 'review'
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
for output in ('cache-hit', 'cache-identity', 'cache-save-outcome', 'cache-size-bytes', 'duration-ms', 'index-ms', 'warmup-result'):
    assert action['outputs'][output]['value'] == '${{ steps.finalize.outputs.' + output + ' }}'
PY
}

@test "secondary action rejects unsupported execution modes" {
  export REDLINE_CODE_INDEX_MODE=invalid
  run bash "$ACTION_DIR/run.sh" prepare
  [ "$status" -eq 2 ]
  [[ "$output" == *"Unsupported code-index mode: invalid"* ]]
  [ ! -e "$RUNNER_TEMP/redline-code-index" ]
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

  python3 - "$TMP_ROOT/cold.json" "$TMP_ROOT/warm.json" "$HEAD_REVISION" "$BASE" <<'PY'
import hashlib, json, sys
cold = json.load(open(sys.argv[1], encoding='utf-8'))
warm = json.load(open(sys.argv[2], encoding='utf-8'))
assert cold['version'] == 2
assert cold['provider'] == {'id': 'cgc', 'version': '0.5.7'}
assert cold['revision'] == sys.argv[3]
assert cold['baseRevision'] == sys.argv[4]
assert cold['status'] == warm['status'] == 'complete'
assert cold['files'] == warm['files']
assert isinstance(cold['timings']['saveMs'], int)
assert warm['timings']['indexMs'] == 0
assert any(item['code'] == 'cache-save-failed' for item in cold['diagnostics'])
span = cold['files'][0]['related'][0]
assert {key: span[key] for key in ('path', 'startLine', 'endLine', 'reason')} == {
    'path': 'src/user-service.ts',
    'startLine': 3,
    'endLine': 5,
    'reason': 'related-symbol-calls-changed-code',
}
reference = span['graphReference']
fact = {key: value for key, value in reference.items() if key != 'graphFactDigest'}
canonical = json.dumps(fact, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
assert reference['snapshotRevision'] == sys.argv[4]
assert reference['graphFactDigest'] == f"sha256:{hashlib.sha256(canonical).hexdigest()}"
assert any(item['code'] == 'cache-base-revision' for item in warm['diagnostics'])
PY
}

@test "CGC query bounds do not restrict provider database writes" {
  prepare_action
  printf 'query-state\n' > "$PROVIDER/mode"
  build_action '' success

  python3 - "$REDLINE_CODE_INDEX_OUTPUT_DIRECTORY/code-context.json" <<'PY'
import json, sys
artifact = json.load(open(sys.argv[1], encoding='utf-8'))
print(json.dumps(artifact, sort_keys=True))
assert artifact['status'] == 'complete'
PY
}

@test "provider read failures stop and reap the process" {
  python3 - "$ACTION_DIR/export.py" "$TMP_ROOT/provider.pid" <<'PY'
import importlib.util
import os
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location("redline_code_index_export", sys.argv[1])
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
pid_file = Path(sys.argv[2])
provider = """
import os
from pathlib import Path
import sys
import time

Path(sys.argv[1]).write_text(str(os.getpid()), encoding="utf-8")
sys.stdout.buffer.write(b"[")
sys.stdout.buffer.flush()
time.sleep(30)
"""
original_read = module.os.read
original_select = module.selectors.DefaultSelector.select


def fail_read(_descriptor, _length):
    raise OSError("forced provider read failure")


def select_then_fail_read(selector, timeout=None):
    events = original_select(selector, timeout)
    module.os.read = fail_read
    return events


module.selectors.DefaultSelector.select = select_then_fail_read
try:
    try:
        module.run_provider_json(
            [sys.executable, "-c", provider, str(pid_file)],
            os.environ.copy(),
            5,
        )
    except OSError as error:
        assert str(error) == "forced provider read failure"
    else:
        raise AssertionError("provider read failure was not propagated")
finally:
    module.os.read = original_read
    module.selectors.DefaultSelector.select = original_select

provider_pid = int(pid_file.read_text(encoding="utf-8"))
try:
    os.kill(provider_pid, 0)
except ProcessLookupError:
    pass
else:
    os.kill(provider_pid, 9)
    raise AssertionError("provider process was not stopped")
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
assert artifact['baseRevision'] == sys.argv[3]
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

@test "cache identity rejects provider, repository, configuration, revision, and platform mismatches" {
  prepare_action
  cgc_identity=$(grep '^cache-identity=' "$GITHUB_OUTPUT" | tail -n 1 | cut -d= -f2-)
  build_action '' success

  for field in provider providerVersion repository revision configuration sourceRoot; do
    python3 - "$RUNNER_TEMP/redline-code-index/cache/state.json" "$field" "$HEAD_REVISION" <<'PY'
import json, sys
path, field, head = sys.argv[1:]
state = json.load(open(path, encoding='utf-8'))
replacements = {
    'provider': 'gitnexus',
    'providerVersion': '0.0.0',
    'repository': 'other/repository',
    'revision': head,
    'configuration': 'other-configuration',
    'sourceRoot': '/other/source',
}
state[field] = replacements[field]
with open(path, 'w', encoding='utf-8') as handle:
    json.dump(state, handle)
PY
    : > "$PROVIDER/calls.log"
    build_action "redline-code-index-mismatched-$field" success
    [ "$(grep -c '^index ' "$PROVIDER/calls.log")" -eq 1 ]
    python3 - "$REDLINE_CODE_INDEX_OUTPUT_DIRECTORY/code-context.json" <<'PY'
import json, sys
artifact = json.load(open(sys.argv[1], encoding='utf-8'))
assert any(item['code'] == 'cache-restore-invalid' for item in artifact['diagnostics'])
PY
  done

  export REDLINE_CODE_INDEX_PROVIDER=gitnexus
  export REDLINE_GITNEXUS_EXECUTABLE="$GITNEXUS_PROVIDER/dist/cli/index.js"
  export REDLINE_GITNEXUS_RUNTIME
  REDLINE_GITNEXUS_RUNTIME=$(command -v node)
  unset REDLINE_CGC_EXECUTABLE
  export RUNNER_ARCH=X64
  : > "$GITHUB_OUTPUT"
  prepare_action
  x64_identity=$(grep '^cache-identity=' "$GITHUB_OUTPUT" | tail -n 1 | cut -d= -f2-)
  export RUNNER_ARCH=ARM64
  : > "$GITHUB_OUTPUT"
  prepare_action
  arm64_identity=$(grep '^cache-identity=' "$GITHUB_OUTPUT" | tail -n 1 | cut -d= -f2-)

  [[ "$cgc_identity" != "$x64_identity" ]]
  [[ "$x64_identity" != "$arm64_identity" ]]
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

@test "unsupported-only reviews skip a no-benefit cold index" {
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

  grep -Fq 'cache-ready=false' "$GITHUB_OUTPUT"
  ! grep -Fq "index $RUNNER_TEMP/redline-code-index/source --no-progress" "$PROVIDER/calls.log"
  [ ! -f "$RUNNER_TEMP/redline-code-index/cache/state.json" ]
  python3 - "$REDLINE_CODE_INDEX_OUTPUT_DIRECTORY/code-context.json" <<'PY'
import json, sys
artifact = json.load(open(sys.argv[1], encoding='utf-8'))
assert artifact['status'] == 'unsupported'
assert artifact['files'] == [{
    'changedPath': '.github/workflows/cache-test.yml',
    'status': 'unsupported',
    'related': [],
}]
codes = {item['code'] for item in artifact['diagnostics']}
assert {'no-supported-changed-files', 'cold-index-skipped'} <= codes
assert artifact['timings']['indexMs'] == 0
PY
}

@test "all-head-new supported reviews skip a no-benefit cold index" {
  git -C "$REPOSITORY" reset -q --hard "$BASE"
  cat > "$REPOSITORY/src/new-module.ts" <<'EOF'
export const newModule = true;
EOF
  git -C "$REPOSITORY" add src/new-module.ts
  git -C "$REPOSITORY" commit -q -m all-head-new
  HEAD_REVISION=$(git -C "$REPOSITORY" rev-parse HEAD)
  export REDLINE_CODE_INDEX_HEAD="$HEAD_REVISION"

  prepare_action
  : > "$PROVIDER/calls.log"
  build_action '' success

  grep -Fq 'cache-ready=false' "$GITHUB_OUTPUT"
  ! grep -Fq "index $RUNNER_TEMP/redline-code-index/source --no-progress" "$PROVIDER/calls.log"
  [ ! -f "$RUNNER_TEMP/redline-code-index/cache/state.json" ]
  python3 - "$REDLINE_CODE_INDEX_OUTPUT_DIRECTORY/code-context.json" <<'PY'
import json, sys
artifact = json.load(open(sys.argv[1], encoding='utf-8'))
assert artifact['status'] == 'partial'
assert artifact['files'] == [{
    'changedPath': 'src/new-module.ts',
    'status': 'partial',
    'related': [],
}]
codes = {item['code'] for item in artifact['diagnostics']}
assert {'changed-file-absent-from-base', 'no-base-query-anchors', 'cold-index-skipped'} <= codes
assert artifact['timings']['indexMs'] == 0
PY
}

@test "warmup builds an exact-base cache that a later review reuses without indexing" {
  review_head="$HEAD_REVISION"
  export REDLINE_CODE_INDEX_MODE=warmup
  export REDLINE_CODE_INDEX_HEAD="$BASE"

  prepare_action
  cache_identity=$(grep '^cache-identity=' "$GITHUB_OUTPUT" | tail -n 1 | cut -d= -f2-)
  : > "$PROVIDER/calls.log"
  build_action '' success

  grep -Fq 'cache-ready=true' "$GITHUB_OUTPUT"
  grep -Fq "index $RUNNER_TEMP/redline-code-index/source --no-progress" "$PROVIDER/calls.log"
  [ -f "$RUNNER_TEMP/redline-code-index/cache/state.json" ]
  python3 - "$REDLINE_CODE_INDEX_OUTPUT_DIRECTORY/code-context.json" "$BASE" <<'PY'
import json, sys
artifact = json.load(open(sys.argv[1], encoding='utf-8'))
assert artifact['revision'] == artifact['baseRevision'] == sys.argv[2]
assert artifact['files'] == []
assert any(item['code'] == 'exact-base-warmup' for item in artifact['diagnostics'])
PY
  run bash "$ACTION_DIR/run.sh" save-start
  [ "$status" -eq 0 ]
  export REDLINE_CODE_INDEX_CACHE_IDENTITY="$cache_identity"
  export REDLINE_CODE_INDEX_CACHE_READY=true
  export REDLINE_CODE_INDEX_CACHE_SAVE_OUTCOME=success
  run bash "$ACTION_DIR/run.sh" finalize
  [ "$status" -eq 0 ]
  grep -Fq 'warmup-result=saved' "$GITHUB_OUTPUT"
  grep -Fq "cache-identity=$cache_identity" "$GITHUB_OUTPUT"

  export REDLINE_CODE_INDEX_MODE=review
  export REDLINE_CODE_INDEX_HEAD="$review_head"
  : > "$PROVIDER/calls.log"
  build_action "$cache_identity" success
  ! grep -Fq "index $RUNNER_TEMP/redline-code-index/source --no-progress" "$PROVIDER/calls.log"
  export REDLINE_CODE_INDEX_CACHE_READY=false
  export REDLINE_CODE_INDEX_CACHE_SAVE_OUTCOME=skipped
  run bash "$ACTION_DIR/run.sh" finalize
  [ "$status" -eq 0 ]
  grep -Fq 'cache-hit=true' "$GITHUB_OUTPUT"
  grep -Fq 'index-ms=0' "$GITHUB_OUTPUT"
  grep -Fq 'warmup-result=not-requested' "$GITHUB_OUTPUT"
  python3 - "$REDLINE_CODE_INDEX_OUTPUT_DIRECTORY/code-context.json" "$RUNNER_TEMP/redline-code-index/cache/state.json" "$BASE" "$review_head" <<'PY'
import json, sys
artifact = json.load(open(sys.argv[1], encoding='utf-8'))
state = json.load(open(sys.argv[2], encoding='utf-8'))
assert artifact['revision'] == sys.argv[4]
assert artifact['baseRevision'] == state['revision'] == sys.argv[3]
assert artifact['status'] == 'complete'
assert artifact['timings']['indexMs'] == 0
assert any(item['code'] == 'cache-base-revision' for item in artifact['diagnostics'])
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

  python3 - "$TMP_ROOT/gitnexus-cold.json" "$TMP_ROOT/gitnexus-warm.json" "$HEAD_REVISION" "$BASE" <<'PY'
import hashlib, json, sys
cold = json.load(open(sys.argv[1], encoding='utf-8'))
warm = json.load(open(sys.argv[2], encoding='utf-8'))
assert cold['provider'] == {'id': 'gitnexus', 'version': '1.6.12'}
assert cold['revision'] == sys.argv[3]
assert cold['baseRevision'] == sys.argv[4]
assert cold['status'] == warm['status'] == 'complete'
assert cold['files'] == warm['files']
assert warm['timings']['indexMs'] == 0
span = cold['files'][0]['related'][0]
assert {key: span[key] for key in ('path', 'startLine', 'endLine', 'reason')} == {
    'path': 'src/user-service.ts',
    'startLine': 3,
    'endLine': 5,
    'reason': 'related-symbol-calls-changed-code',
}
reference = span['graphReference']
fact = {key: value for key, value in reference.items() if key != 'graphFactDigest'}
canonical = json.dumps(fact, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
assert reference['snapshotRevision'] == sys.argv[4]
assert reference['graphFactDigest'] == f"sha256:{hashlib.sha256(canonical).hexdigest()}"
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

@test "action-owned follow-up uses pinned fake CGC and GitNexus base snapshots without indexing PR code" {
  for provider in cgc gitnexus; do
    export REDLINE_CODE_INDEX_PROVIDER="$provider"
    if [[ "$provider" == gitnexus ]]; then
      export REDLINE_GITNEXUS_EXECUTABLE="$GITNEXUS_PROVIDER/dist/cli/index.js"
      export REDLINE_GITNEXUS_RUNTIME
      REDLINE_GITNEXUS_RUNTIME=$(command -v node)
      unset REDLINE_CGC_EXECUTABLE
    fi
    prepare_action
    build_action '' success
    write_follow_up_fixture
    run run_follow_up_worker "$provider"
    [ "$status" -eq 0 ]
    assert_complete_follow_up "$provider"
    run node --input-type=module - "$ROOT" "$TMP_ROOT/review" "$RUNNER_TEMP" "$provider" "$BASE" "$HEAD_REVISION" <<'JS'
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, reviewDirectory, runnerTemp, provider, base, head] = process.argv.slice(2);
const { FollowUpBudget, parseFollowUpResults } = await import(pathToFileURL(join(root, 'dist/src/code-context/follow-up.js')));
const { createActionFollowUpExecutor } = await import(pathToFileURL(join(root, 'dist/src/action/follow-up.js')));
const candidateId = 'f-' + 'b'.repeat(24);
const request = new FollowUpBudget().plan({ repository: 'owner/repository', base, head },
  '000001', 'src/cache.ts', [candidateId], [{ candidateId, direction: 'incoming' }]);
const output = await createActionFollowUpExecutor({ provider, runnerTemp, reviewDirectory, actionRoot: root })(request);
const parsed = parseFollowUpResults(output, request, {
  id: provider, version: provider === 'cgc' ? '0.5.7' : '1.6.12',
});
assert.equal(parsed.results[0]?.status, 'complete');
assert.equal(parsed.results[0]?.spans[0]?.revision, head);
JS
    [ "$status" -eq 0 ]
    python3 - "$TMP_ROOT/requests.json" "$TMP_ROOT/invalid.json" <<'PY'
import json, sys
request = json.load(open(sys.argv[1], encoding='utf-8'))
request['requests'][0]['direction'] = "MATCH (n) DELETE n"
with open(sys.argv[2], 'w', encoding='utf-8') as handle:
    json.dump(request, handle)
PY
    run python3 "$ACTION_DIR/follow-up.py" --provider "$provider" --repository owner/repository \
      --base "$BASE" --head "$HEAD_REVISION" --review-dir "$TMP_ROOT/review" \
      --runner-temp "$RUNNER_TEMP" --input "$TMP_ROOT/invalid.json" --output "$TMP_ROOT/invalid-result.json"
    [ "$status" -eq 2 ]
    [ ! -f "$TMP_ROOT/invalid-result.json" ]

    if [[ "$provider" == cgc ]]; then
      printf 'query-fail\n' > "$PROVIDER/mode"
    else
      printf 'query-fail\n' > "$GITNEXUS_CONTROL/mode"
    fi
    run python3 "$ACTION_DIR/follow-up.py" --provider "$provider" --repository owner/repository \
      --base "$BASE" --head "$HEAD_REVISION" --review-dir "$TMP_ROOT/review" \
      --runner-temp "$RUNNER_TEMP" --input "$TMP_ROOT/requests.json" --output "$TMP_ROOT/result.json"
    [ "$status" -eq 0 ]
    python3 - "$TMP_ROOT/result.json" <<'PY'
import json, sys
result = json.load(open(sys.argv[1], encoding='utf-8'))['results'][0]
assert result['status'] == 'unavailable' and result['reason'] == 'query-failed' and result['spans'] == []
PY
    if [[ "$provider" == cgc ]]; then
      rm -f "$PROVIDER/mode"
    else
      rm -f "$GITNEXUS_CONTROL/mode"
    fi
    rm "$RUNNER_TEMP/redline-code-index/head-source/src/user-service.ts"
    run python3 "$ACTION_DIR/follow-up.py" --provider "$provider" --repository owner/repository \
      --base "$BASE" --head "$HEAD_REVISION" --review-dir "$TMP_ROOT/review" \
      --runner-temp "$RUNNER_TEMP" --input "$TMP_ROOT/requests.json" --output "$TMP_ROOT/result.json"
    [ "$status" -eq 0 ]
    python3 - "$TMP_ROOT/result.json" <<'PY'
import json, sys
result = json.load(open(sys.argv[1], encoding='utf-8'))['results'][0]
assert result['status'] == 'partial' and result['reason'] == 'source-unavailable' and result['spans'] == []
PY
    python3 - "$RUNNER_TEMP/redline-code-index/cache/state.json" "$HEAD_REVISION" <<'PY'
import json, sys
path, head = sys.argv[1:]
state = json.load(open(path, encoding='utf-8'))
state['revision'] = head
with open(path, 'w', encoding='utf-8') as handle:
    json.dump(state, handle)
PY
    run python3 "$ACTION_DIR/follow-up.py" --provider "$provider" --repository owner/repository \
      --base "$BASE" --head "$HEAD_REVISION" --review-dir "$TMP_ROOT/review" \
      --runner-temp "$RUNNER_TEMP" --input "$TMP_ROOT/requests.json" --output "$TMP_ROOT/result.json"
    [ "$status" -eq 0 ]
    python3 - "$TMP_ROOT/result.json" <<'PY'
import json, sys
result = json.load(open(sys.argv[1], encoding='utf-8'))
assert result['results'][0]['status'] == 'unavailable'
assert result['results'][0]['reason'] == 'snapshot-stale'
assert result['results'][0]['spans'] == []
PY
  done
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
assert cold['provider'] == warm['provider'] == {'id': 'gitnexus', 'version': '1.6.12'}
assert cold['status'] == warm['status'] == 'complete'
assert cold['files'] == warm['files']
assert cold['timings']['indexMs'] >= 0
assert warm['timings']['indexMs'] == 0
assert any(item['code'] == 'cache-base-revision' for item in warm['diagnostics'])
PY
  write_follow_up_fixture
  benchmark_follow_up gitnexus
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
assert artifact['provider'] == {'id': 'cgc', 'version': '0.5.7'}
assert artifact['status'] == 'complete'
span = artifact['files'][0]['related'][0]
assert {key: span[key] for key in ('path', 'startLine', 'endLine', 'reason')} == {
    'path': 'src/user-service.ts',
    'startLine': 3,
    'endLine': 5,
    'reason': 'related-symbol-calls-changed-code',
}
assert span['graphReference']['provider'] == 'cgc'
assert span['graphReference']['providerVersion'] == '0.5.7'
assert span['graphReference']['snapshotRevision'] == artifact['baseRevision']
timings = artifact['timings']
for key in ('installationMs', 'restoreMs', 'validationMs', 'indexMs', 'queryMs'):
    assert isinstance(timings[key], int) and timings[key] >= 0
assert timings['saveMs'] is None or isinstance(timings['saveMs'], int)
PY
  write_follow_up_fixture
  benchmark_follow_up cgc
}
