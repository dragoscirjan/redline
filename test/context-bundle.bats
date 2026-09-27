#!/usr/bin/env bats

setup() {
  ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  SCRIPT="$ROOT/src/context-bundle.sh"
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
  run bash -c 'cd "$1" && bash "$2" --base "$3" --head "$4" --output "$5" --source "$6"' _ "$TMP/source" "$SCRIPT" "$BASE" "$HEAD_SHA" "$TMP/review" "$TMP/source-at-head"
  [ "$status" -eq 0 ]
  [ -f "$TMP/review/manifest.json" ]
  grep -Fq "$BASE" "$TMP/review/revisions.txt"
  grep -Fq "$HEAD_SHA" "$TMP/review/revisions.txt"
  grep -Fq '"status": "R"' "$TMP/review/manifest.json"
  grep -Fq '"binary": true' "$TMP/review/manifest.json"
  grep -Fq 'src/old name.txt' "$TMP/review/manifest.json"
  grep -Fq 'src/new name.txt' "$TMP/review/manifest.json"
  grep -Fq 'config/new file.txt' "$TMP/review/manifest.json"
  grep -Fq 'reviewed' "$TMP/review/manifest.json"
  [ -n "$(find "$TMP/review/diffs" -type f -print -quit)" ]
  [ -n "$(find "$TMP/review/base-files" -type f -print -quit)" ]
  [ -f "$TMP/review/summary.txt" ]
  [ -f "$TMP/review/commits.txt" ]
  [ -f "$TMP/review/README.md" ]
  [ -f "$TMP/source-at-head/src/new name.txt" ]
}

@test "rejects missing arguments" {
  run bash "$SCRIPT"
  [ "$status" -eq 2 ]
}

@test "rejects unresolved revision" {
  run bash -c 'cd "$1" && bash "$2" --base missing-revision --head "$3" --output "$4"' _ "$TMP/source" "$SCRIPT" "$HEAD_SHA" "$TMP/review"
  [ "$status" -ne 0 ]
}
