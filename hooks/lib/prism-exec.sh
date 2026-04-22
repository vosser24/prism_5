#!/usr/bin/env bash
# PRISM hook node-exec wrapper (v2.2.0)
#
# [WHY] Every hook invokes `node ~/.claude/hooks/<hook>.mjs` directly. On
# Linux / macOS where node is not on PATH (fresh machine, broken install,
# node version-manager not sourced for non-interactive shells), the hook
# call fails and the user sees a stderr spew on every prompt / every tool
# use / every session end. That's a paper-cut that makes PRISM feel broken
# when really node is just missing.
#
# This wrapper guards the node call: if node is absent we silently exit 0
# (hook becomes a no-op). If node is present we exec it with the passed
# arguments (the hook's .mjs path + any extra args). stdin is untouched so
# piped payloads pass through.
#
# Usage from settings.fragment.json:
#   "command": "bash ~/.claude/hooks/lib/prism-exec.sh ~/.claude/hooks/<hook>.mjs"
#
# Exit codes preserved from the underlying node process. No-node = exit 0
# (not exit 2) because a missing interpreter is NOT a policy denial.
set -u
if ! command -v node >/dev/null 2>&1; then
  exit 0
fi
exec node "$@"
