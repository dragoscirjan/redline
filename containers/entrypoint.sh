#!/bin/sh
# Seed image defaults only. User-supplied global and project configuration remains authoritative.
set -eu
umask 077

home=${HOME:-/tmp/redline/home}
pi_dir=${PI_CODING_AGENT_DIR:-"$home/.pi/agent"}
opencode_dir=${XDG_CONFIG_HOME:-"$home/.config"}/opencode
if ! mkdir -p "$pi_dir" "$opencode_dir" /tmp/redline/native/context-mode /tmp/redline/native/parsers \
  /cache/redline/native/cgc /cache/redline/native/gitnexus 2>/dev/null; then
  printf '%s\n' 'Warning: native MCP state/configuration directories could not be prepared; continuing with native harness configuration.' >&2
fi

if [ ! -e "$pi_dir/mcp.json" ]; then
  if ! cp --no-clobber /opt/redline/native-config/pi-mcp.json "$pi_dir/mcp.json" 2>/dev/null; then
    printf '%s\n' 'Warning: Pi MCP defaults could not be seeded; continuing with native harness configuration.' >&2
  fi
fi
if [ ! -e "$opencode_dir/opencode.json" ] && [ ! -e "$opencode_dir/opencode.jsonc" ] && [ ! -e "$opencode_dir/config.json" ]; then
  if ! cp --no-clobber /opt/redline/native-config/opencode.json "$opencode_dir/opencode.json" 2>/dev/null; then
    printf '%s\n' 'Warning: OpenCode MCP defaults could not be seeded; continuing with native harness configuration.' >&2
  fi
fi

exec node /opt/redline/bin/redline.mjs "$@"
