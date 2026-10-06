#!/usr/bin/env bats

setup() {
  ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  CLI="$ROOT/dist/src/review/cli.js"
  SCRIPT="$ROOT/src/context-bundle.sh"
  TMP="$(mktemp -d)"
  REPO="$TMP/repo"
  mkdir -p "$REPO/src"
  git -C "$REPO" init -q
  git -C "$REPO" config user.name Test
  git -C "$REPO" config user.email test@example.invalid
  git -C "$REPO" config core.autocrlf false
  printf 'This line is long enough to survive the bundle diff filter.\n' > "$REPO/src/example.ts"
  git -C "$REPO" add .
  git -C "$REPO" commit -qm base
  BASE="$(git -C "$REPO" rev-parse HEAD)"
  printf 'This line is long enough to survive the bundle diff filter.\nsecond line\n' > "$REPO/src/example.ts"
  git -C "$REPO" add .
  git -C "$REPO" commit -qm head
  HEAD="$(git -C "$REPO" rev-parse HEAD)"
  mkdir -p "$TMP/review" "$TMP/output"
  git -C "$REPO" worktree add --detach "$TMP/source" "$HEAD" >/dev/null 2>&1
}

teardown() {
  rm -rf "$TMP"
}

build_bundle() {
  (
    cd "$TMP/source"
    bash "$SCRIPT" --base "$BASE" --head "$HEAD" --output "$TMP/review" --source "$TMP/source-at-head"
  )
}

@test "requires a prior build of the CLI" {
  [ -f "$CLI" ]
}

@test "validate-only rejects partial review inputs" {
  REDLINE_HARNESS=pi run node "$CLI" --validate-only
  [ "$status" -eq 2 ]
}

@test "validate-only rejects unknown REDLINE variables" {
  REDLINE_HARNESSS=typo run node "$CLI" --validate-only
  [ "$status" -eq 2 ]
}

@test "context-only mode validates and exits zero" {
  REDLINE_FINDING_SCOPE=defects run node "$CLI" --validate-only
  [ "$status" -eq 0 ]
  [[ "$output" == *'"mode":"context-only"'* ]]
}

@test "echo harness reviews the fixture bundle end to end" {
  build_bundle
  REDLINE_HARNESS=echo \
  REDLINE_REVIEW_DIR="$TMP/review" \
  REDLINE_SOURCE_DIR="$TMP/source-at-head" \
  REDLINE_OUTPUT_DIR="$TMP/output" \
  REDLINE_MODEL_CONFIG='{"provider":"mock","endpoint":"http://127.0.0.1:9/v1","model":"test-model"}' \
  REDLINE_MODEL_AUTH='{"mock":"test-key"}' \
  run node "$CLI"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"reviewedFiles":1'* ]]
  [ -f "$TMP/output/reviews/000001.json" ]
  [ -f "$TMP/output/reviews/000001.md" ]
  [ -f "$TMP/output/reviews/summary.json" ]
  [ -f "$TMP/output/reviews/summary.md" ]
  grep -Fq '"outcome": "clean"' "$TMP/output/reviews/000001.json"
  grep -Fq '# Review:' "$TMP/output/reviews/000001.md"
}

@test "excludes lock files and generated directories from review deterministically" {
  mkdir -p "$REPO/packages/app" "$REPO/apps/web/node_modules/dep" "$REPO/apps/web/dist"
  printf '{}' > "$REPO/pnpm-lock.yaml"
  printf '{}' > "$REPO/packages/app/package-lock.json"
  printf 'x\n' > "$REPO/apps/web/node_modules/dep/index.js"
  printf 'y\n' > "$REPO/apps/web/dist/bundle.js"
  printf 'more text for the fixture file\n' >> "$REPO/src/example.ts"
  git -C "$REPO" add .
  git -C "$REPO" commit -qm 'add lock files and generated output'
  HEAD="$(git -C "$REPO" rev-parse HEAD)"
  rm -rf "$TMP/review" "$TMP/source-at-head" "$TMP/source"
  git -C "$REPO" worktree prune
  mkdir -p "$TMP/review"
  git -C "$REPO" worktree add --detach "$TMP/source" "$HEAD" >/dev/null 2>&1
  build_bundle
  run node -e '
    const m = require(process.argv[1]);
    const excluded = (f) => {
      if (!f.reviewed) return true;
      return false;
    };
    const lock = m.files.find((f) => f.newPath === "pnpm-lock.yaml");
    const nestedLock = m.files.find((f) => f.newPath === "packages/app/package-lock.json");
    const vendored = m.files.find((f) => f.newPath === "apps/web/node_modules/dep/index.js");
    const generated = m.files.find((f) => f.newPath === "apps/web/dist/bundle.js");
    const source = m.files.find((f) => f.newPath === "src/example.ts");
    const failures = [];
    for (const [label, entry] of Object.entries({ lock, nestedLock, vendored, generated })) {
      if (!entry || !excluded(entry)) failures.push(`${label} not excluded`);
    }
    if (!source || source.reviewed !== true) failures.push("src/example.ts not reviewed");
    if (failures.length > 0) {
      console.error(failures.join(", "));
      process.exit(1);
    }
  ' "$TMP/review/manifest.json"
  [ "$status" -eq 0 ]
}

@test "fails loudly when the review bundle is missing" {
  REDLINE_HARNESS=echo \
  REDLINE_REVIEW_DIR="$TMP/nonexistent-review" \
  REDLINE_SOURCE_DIR="$TMP/source-at-head" \
  REDLINE_OUTPUT_DIR="$TMP/output" \
  REDLINE_MODEL_CONFIG='{"provider":"mock","endpoint":"http://127.0.0.1:9/v1","model":"test-model"}' \
  REDLINE_MODEL_AUTH='{"mock":"test-key"}' \
  run node "$CLI"
  [ "$status" -eq 1 ]
}
