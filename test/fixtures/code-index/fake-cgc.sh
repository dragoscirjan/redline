#!/bin/sh
set -eu

case $0 in
  */*) script_directory=${0%/*} ;;
  *) script_directory=. ;;
esac
control=$(cd "$script_directory" && pwd)
database_path=${CGC_RUNTIME_DB_PATH:-/invalid/database}
database_root=${database_path%/*}
mode=ok
[ ! -f "$control/mode" ] || IFS= read -r mode < "$control/mode"
printf '%s\n' "$*" >> "$control/calls.log"

print_file() {
  while IFS= read -r line || [ -n "$line" ]; do
    printf '%s\n' "$line"
  done < "$1"
}

case "${1:-}" in
  version)
    printf 'CodeGraphContext 0.5.7\n'
    ;;
  index)
    [ "$mode" != 'index-fail' ] || exit 21
    : > "${database_root:?}/valid"
    ;;
  update)
    [ "$mode" != 'update-fail' ] || exit 22
    : > "${database_root:?}/valid"
    ;;
  query)
    [ "$mode" != 'query-fail' ] || exit 23
    query=${2:-}
    case "$query" in
      *repository_count*)
        [ -f "${database_root:?}/valid" ] || exit 24
        printf '[{"repository_count":1}]\n'
        ;;
      'MATCH (changed)'*)
        if [ -f "$control/results-outgoing.json" ]; then
          print_file "$control/results-outgoing.json"
        else
          printf '[]\n'
        fi
        ;;
      *)
        if [ -f "$control/results-incoming.json" ]; then
          print_file "$control/results-incoming.json"
        else
          printf '[]\n'
        fi
        ;;
    esac
    ;;
  *)
    exit 25
    ;;
esac
