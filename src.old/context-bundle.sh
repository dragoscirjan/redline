#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage: %s --base <commit> --head <commit> --output <review-dir> [--source <source-dir>]\n' "$0" >&2
  exit 2
}

base=''
head=''
output=''
source_dir=''
while (($#)); do
  case "$1" in
    --base) (($# >= 2)) || usage; base=$2; shift 2 ;;
    --head) (($# >= 2)) || usage; head=$2; shift 2 ;;
    --output) (($# >= 2)) || usage; output=$2; shift 2 ;;
    --source) (($# >= 2)) || usage; source_dir=$2; shift 2 ;;
    *) usage ;;
  esac
done
[[ -n "$base" && -n "$head" && -n "$output" ]] || usage

repo=$(git rev-parse --show-toplevel)
base=$(git -C "$repo" rev-parse --verify "$base^{commit}")
head=$(git -C "$repo" rev-parse --verify "$head^{commit}")
git -C "$repo" cat-file -e "$base^{commit}"
git -C "$repo" cat-file -e "$head^{commit}"

mkdir -p "$output/raw" "$output/diffs" "$output/base-files" "$output/commits" "$output/test-results"
if [[ -n "$source_dir" ]]; then
  mkdir -p "$source_dir"
  git -C "$repo" archive "$head" | tar -x -C "$source_dir"
fi

printf 'base=%s\nhead=%s\n' "$base" "$head" > "$output/revisions.txt"
git -C "$repo" diff --name-status -z --find-renames "$base" "$head" > "$output/raw/name-status.z"
git -C "$repo" diff --numstat -z --find-renames "$base" "$head" > "$output/raw/numstat.z"
git -C "$repo" diff --stat --find-renames "$base" "$head" > "$output/summary.txt"
git -C "$repo" log --reverse --format=fuller "$base..$head" > "$output/commits.txt"
git -C "$repo" rev-list --reverse "$base..$head" > "$output/raw/commit-ids.txt"
if [[ ! -s "$output/raw/commit-ids.txt" ]]; then
  git -C "$repo" rev-parse "$head" > "$output/raw/commit-ids.txt"
fi

python3 - "$repo" "$base" "$head" "$output" <<'PY'
import json
import os
import subprocess
import sys

repo, base, head, output = sys.argv[1:]
name_status = open(os.path.join(output, 'raw', 'name-status.z'), 'rb').read().split(b'\0')
numstat = open(os.path.join(output, 'raw', 'numstat.z'), 'rb').read().split(b'\0')
for raw in name_status:
    if raw.startswith((b'R', b'C')) and len(raw) > 1 and raw[1:].isdigit():
        continue
    if raw and (raw[0:1] in (b'A', b'M', b'D', b'T', b'U', b'X', b'B')):
        continue
if name_status and name_status[-1] == b'': name_status.pop()
if numstat and numstat[-1] == b'': numstat.pop()

def path(raw):
    return os.fsdecode(raw)

def run(args):
    return subprocess.run(['git', '-C', repo, *args], check=True, stdout=subprocess.PIPE).stdout

files = []
i = 0
j = 0
while i < len(name_status):
    status = name_status[i].decode('ascii')
    i += 1
    if len(status) > 1 and status[0] in 'RC':
        similarity = int(status[1:])
    else:
        similarity = None
    if status.startswith(('R', 'C')):
        if i + 1 >= len(name_status): raise SystemExit('Truncated rename/copy record')
        old_path = path(name_status[i])
        new_path = path(name_status[i + 1])
        i += 2
    else:
        if i >= len(name_status): raise SystemExit('Truncated file path record')
        old_path = new_path = path(name_status[i])
        i += 1
    if j >= len(numstat): raise SystemExit('Missing numstat record')
    stats = numstat[j].split(b'\t', 2)
    j += 1
    if len(stats) != 3: raise SystemExit('Malformed NUL-delimited numstat data')
    additions = None if stats[0] == b'-' else int(stats[0])
    deletions = None if stats[1] == b'-' else int(stats[1])
    binary = additions is None or deletions is None
    if stats[2] == b'':
        if j + 1 >= len(numstat): raise SystemExit('Truncated rename numstat record')
        old_path = path(numstat[j])
        new_path = path(numstat[j + 1])
        j += 2
    elif not status.startswith(('R', 'C')):
        old_path = new_path = path(stats[2])
    entry_id = f'{len(files) + 1:06d}'
    diff_file = f'diffs/{entry_id}.diff'
    paths = [old_path] if status.startswith('D') else sorted(set([old_path, new_path]))
    patch = run(['diff', '--no-ext-diff', '--find-renames', '--binary', base, head, '--', *paths])
    with open(os.path.join(output, diff_file), 'wb') as f: f.write(patch)
    base_file = None
    if status.startswith(('D', 'R')):
        base_file = f'base-files/{entry_id}'
        old = subprocess.run(['git', '-C', repo, 'show', f'{base}:{old_path}'], stdout=subprocess.PIPE)
        if old.returncode == 0:
            with open(os.path.join(output, base_file), 'wb') as f: f.write(old.stdout)
        else:
            base_file = None
    files.append({'id': entry_id, 'status': status[0], 'oldPath': old_path if status.startswith(('D', 'R', 'C')) else None,
                  'newPath': new_path if not status.startswith('D') else None, 'similarity': similarity,
                  'additions': additions, 'deletions': deletions, 'binary': binary,
                  'diffFile': diff_file, 'baseFile': base_file, 'reviewed': False})
if j != len(numstat): raise SystemExit('Unmatched numstat records')
manifest = {'version': 1, 'base': base, 'head': head, 'files': files}
with open(os.path.join(output, 'manifest.json'), 'w', encoding='utf-8', newline='\n') as f:
    json.dump(manifest, f, ensure_ascii=True, indent=2)
    f.write('\n')

for commit in open(os.path.join(output, 'raw', 'commit-ids.txt'), encoding='ascii'):
    commit = commit.strip()
    if not commit: continue
    patch = run(['show', '--format=fuller', '--find-renames', '--binary', commit])
    with open(os.path.join(output, 'commits', f'{commit}.patch'), 'wb') as f: f.write(patch)
PY

cat > "$output/README.md" <<EOF
# Pull request review bundle

Review the final base-to-head change. Use commit history to understand intent, inspect the source checkout at HEAD for context, and mark each reviewed manifest entry with reviewed=true.

Base: $base
Head: $head

manifest.json is the authoritative changed-file checklist. Each file has a numbered patch under diffs/. Deleted and renamed paths may have their base content under base-files/. Binary patches are stored as bytes and marked in the manifest. No pull request scripts or builds are run while preparing this bundle.
EOF
