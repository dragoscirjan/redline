#!/bin/sh
set -eu
umask 077
export HOME=/tmp/redline/home
export XDG_CONFIG_HOME=/tmp/redline/config
export XDG_DATA_HOME=/tmp/redline/data
export XDG_STATE_HOME=/tmp/redline/state
export TMPDIR=/tmp/redline/tmp
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$TMPDIR"
case "$REDLINE_CONTAINER_HARNESS" in
  pi)
    export PI_CODING_AGENT_DIR=/tmp/redline/pi
    mkdir -p "$PI_CODING_AGENT_DIR"
    cp /redline-input/models.json /redline-input/settings.json "$PI_CODING_AGENT_DIR/"
    exec node /opt/harness/pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js "$@"
    ;;
  opencode)
    export OPENCODE_CONFIG=/redline-input/opencode.json
    exec /opt/harness/opencode-bin "$@"
    ;;
  *) exit 2 ;;
esac
