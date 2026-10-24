#!/usr/bin/env bats

setup() {
  ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  RUNTIME="${SOURCE_RUNTIME:-node}"
  SCRIPT="$ROOT/src/context-bundle.ts"
  TMP="$(mktemp -d)"
  REPO="$TMP/repo"
  mkdir -p "$REPO/src" "$REPO/config"
  git -C "$REPO" init -q
  git -C "$REPO" config user.name Test
  git -C "$REPO" config user.email test@example.invalid
  git -C "$REPO" config core.autocrlf false
  printf 'This is a sufficiently long line with the same content across both filenames, so Git can detect that this file was renamed and only slightly changed.\n' > "$REPO/src/old name.txt"
  printf 'alpha\n' > "$REPO/config/with	 tab.txt"
  NEWLINE_PATH="$REPO/config/with
newline.txt"
  printf 'line\n' > "$NEWLINE_PATH"
  printf 'binary-old-content-\x00' > "$REPO/blob.bin"
  git -C "$REPO" add .
  git -C "$REPO" commit -qm base
  BASE="$(git -C "$REPO" rev-parse HEAD)"

  mv "$REPO/src/old name.txt" "$REPO/src/new name.txt"
  printf 'This is a sufficiently long line with the same content across both filenames, so Git can detect that this file was renamed and only slightly changed!\n' > "$REPO/src/new name.txt"
  printf 'changed\n' >> "$REPO/config/with	 tab.txt"
  rm "$NEWLINE_PATH"
  printf 'binary-new-content-\x00' > "$REPO/blob.bin"
  printf 'added\n' > "$REPO/config/new file.txt"
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm head
  HEAD_SHA="$(git -C "$REPO" rev-parse HEAD)"

  mkdir -p "$TMP/review"
  run git -C "$REPO" worktree add --detach "$TMP/source" "$HEAD_SHA"
  [ "$status" -eq 0 ]
}

teardown() {
  rm -rf "$TMP"
}

@test "bundle records base/head files, rename paths, and binary status" {
  run bash -c 'cd "$1" && node "$2" --base "$3" --head "$4" --output "$5" --source "$6"' _ "$TMP/source" "$SCRIPT" "$BASE" "$HEAD_SHA" "$TMP/review" "$TMP/source-at-head"
  [ "$status" -eq 0 ]
  [ -f "$TMP/review/manifest.json" ]
  grep -Fq "$BASE" "$TMP/review/revisions.txt"
  grep -Fq "$HEAD_SHA" "$TMP/review/revisions.txt"
  grep -Fq '"status": "R"' "$TMP/review/manifest.json"
  grep -Fq '"binary": true' "$TMP/review/manifest.json"
  grep -Fq 'src/old name.txt' "$TMP/review/manifest.json"
  grep -Fq 'src/new name.txt' "$TMP/review/manifest.json"
  grep -Fq 'config/new file.txt' "$TMP/review/manifest.json"
  grep -Fq '"version": 2' "$TMP/review/manifest.json"
  grep -Fq 'reviewed' "$TMP/review/manifest.json"
  grep -Fq 'exclusionReason' "$TMP/review/manifest.json"
  [ -n "$(find "$TMP/review/diffs" -type f -print -quit)" ]
  [ -n "$(find "$TMP/review/base-files" -type f -print -quit)" ]
  run node - "$TMP/review/manifest.json" "$TMP/review" <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const modified = manifest.files.find((item) => item.status === 'M' && item.newPath.startsWith('config/with'));
if (modified?.reviewed !== true || modified.baseFile === null) process.exit(1);
if (fs.readFileSync(path.join(process.argv[3], modified.baseFile), 'utf8') !== 'alpha\n') process.exit(1);
const binary = manifest.files.find((item) => item.status === 'M' && item.binary === true);
if (binary?.reviewed !== false || binary.baseFile !== null || binary.exclusionReason !== 'binary diff; not reviewable as text') process.exit(1);
JS
  [ "$status" -eq 0 ]
  [ -f "$TMP/review/summary.txt" ]
  [ -f "$TMP/review/commits.txt" ]
  [ -f "$TMP/review/README.md" ]
  [ -f "$TMP/source-at-head/src/new name.txt" ]
}

@test "loads eligibility only from the exact base revision" {
  git -C "$REPO" checkout -q --detach "$BASE"
  mkdir -p "$REPO/.redline" "$REPO/benchmark/example/v1"
  cat > "$REPO/.redline/review-eligibility.json" <<'JSON'
{"version":1,"include":[],"exclude":[{"pattern":"benchmark/**/capture.json","reason":"generated raw benchmark capture"}]}
JSON
  printf '{"sample":1}\n' > "$REPO/benchmark/example/v1/capture.json"
  git -C "$REPO" add .
  git -C "$REPO" commit -qm 'add trusted eligibility policy'
  policy_base="$(git -C "$REPO" rev-parse HEAD)"

  printf '{"sample":2}\n' > "$REPO/benchmark/example/v1/capture.json"
  cat > "$REPO/.redline/review-eligibility.json" <<'JSON'
{"version":1,"include":[],"exclude":[]}
JSON
  git -C "$REPO" add .
  git -C "$REPO" commit -qm 'attempt to change policy in head'
  policy_head="$(git -C "$REPO" rev-parse HEAD)"
  bundle_dir="$TMP/policy-review"

  run bash -c 'cd "$1" && node "$2" --base "$3" --head "$4" --output "$5"' _ "$REPO" "$SCRIPT" "$policy_base" "$policy_head" "$bundle_dir"
  [ "$status" -eq 0 ]
  run node - "$bundle_dir/manifest.json" <<'JS'
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (manifest.eligibility.source !== 'trusted-base') process.exit(1);
const capture = manifest.files.find((item) => item.newPath === 'benchmark/example/v1/capture.json');
if (capture?.reviewed !== false || capture.exclusionReason !== 'generated raw benchmark capture') process.exit(1);
const policy = manifest.files.find((item) => item.newPath === '.redline/review-eligibility.json');
if (policy?.reviewed !== true || policy.exclusionReason !== null) process.exit(1);
JS
  [ "$status" -eq 0 ]
}

@test "accepts a bounded trusted-workflow policy file" {
  policy="$TMP/workflow-policy.json"
  printf '%s\n' '{"version":1,"include":[],"exclude":[{"pattern":"config/**","reason":"generated configuration fixture"}]}' > "$policy"
  bundle_dir="$TMP/workflow-policy-review"

  run bash -c 'cd "$1" && node "$2" --base "$3" --head "$4" --output "$5" --eligibility-policy-file "$6"' _ "$TMP/source" "$SCRIPT" "$BASE" "$HEAD_SHA" "$bundle_dir" "$policy"
  [ "$status" -eq 0 ]
  run node - "$bundle_dir/manifest.json" <<'JS'
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (manifest.eligibility.source !== 'trusted-workflow' || manifest.eligibility.path !== null) process.exit(1);
const excluded = manifest.files.filter((item) => item.newPath?.startsWith('config/'));
if (excluded.length === 0 || excluded.some((item) => item.reviewed || item.exclusionReason !== 'generated configuration fixture')) process.exit(1);
JS
  [ "$status" -eq 0 ]
}

@test "rejects malformed or symlinked trusted-workflow policy files" {
  malformed="$TMP/malformed-policy.json"
  printf '%s\n' '{"version":1,"include":[],"exclude":[{"pattern":"../escape","reason":"bad"}]}' > "$malformed"
  run bash -c 'cd "$1" && node "$2" --base "$3" --head "$4" --output "$5" --eligibility-policy-file "$6"' _ "$TMP/source" "$SCRIPT" "$BASE" "$HEAD_SHA" "$TMP/malformed-review" "$malformed"
  [ "$status" -ne 0 ]

  ln -s "$malformed" "$TMP/policy-link.json"
  run bash -c 'cd "$1" && node "$2" --base "$3" --head "$4" --output "$5" --eligibility-policy-file "$6"' _ "$TMP/source" "$SCRIPT" "$BASE" "$HEAD_SHA" "$TMP/symlink-review" "$TMP/policy-link.json"
  [ "$status" -ne 0 ]
}

@test "rejects missing arguments" {
  run "$RUNTIME" "$SCRIPT"
  [ "$status" -eq 2 ]
}

@test "rejects unresolved revision" {
  run bash -c 'cd "$1" && node "$2" --base missing-revision --head "$3" --output "$4"' _ "$TMP/source" "$SCRIPT" "$HEAD_SHA" "$TMP/review"
  [ "$status" -ne 0 ]
}

@test "does not execute scripts or hooks from the checked-out PR source" {
  marker="$TMP/pr-source-was-executed"
  mkdir -p "$REPO/.github/workflows"
  printf '#!/usr/bin/env bash\ntouch %q\n' "$marker" > "$REPO/.github/workflows/untrusted.sh"
  git -C "$REPO" add .
  git -C "$REPO" commit -qm 'add untrusted script'
  HEAD_SHA="$(git -C "$REPO" rev-parse HEAD)"
  rm -rf "$TMP/source-at-head"
  mkdir -p "$TMP/review"

  run bash -c 'cd "$1" && node "$2" --base "$3" --head "$4" --output "$5" --source "$6"' _ "$TMP/source" "$SCRIPT" "$BASE" "$HEAD_SHA" "$TMP/review" "$TMP/source-at-head"
  [ "$status" -eq 0 ]
  [ -f "$TMP/source-at-head/.github/workflows/untrusted.sh" ]
  [ ! -e "$marker" ]
}
