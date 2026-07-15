#!/usr/bin/env bash
# PRISM hook node-exec wrapper (v2.3.0)
#
# [WHY] Every hook invokes `node ~/.claude/hooks/<hook>.mjs`. When node was
# installed via a version manager (nvm, fnm, volta, asdf) it is only on PATH
# for interactive shells that sourced the manager's init. Claude Code runs
# hooks under a non-interactive `/bin/sh`, which sees no such PATH — so the
# raw `node` call fails with "node: not found" on every prompt / tool use /
# session end. That paper-cut makes PRISM feel broken when node is merely
# hidden.
#
# This wrapper resolves node before exec'ing it, trying in order:
#   1. $PRISM_NODE                         (user override / install-time pin)
#   2. ~/.claude/prism.env                 (installer-written pin)
#   3. command -v node                     (already on PATH — best case)
#   4. newest ~/.nvm/versions/node/*/bin/node
#   5. newest ~/.fnm/node-versions/*/installation/bin/node
#   6. ~/.volta/bin/node
#   7. $(asdf which node)
#   8. /opt/homebrew/bin/node, /usr/local/bin/node
#
# If node is truly absent we silently exit 0 (hook becomes a no-op) — a
# missing interpreter is NOT a policy denial. If node is found we prepend
# its bin dir to PATH so downstream npm/npx invoked by hooks also resolve.
#
# Usage from settings.fragment.json:
#   "command": "bash ~/.claude/hooks/lib/prism-exec.sh ~/.claude/hooks/<hook>.mjs"
#
# Exit codes: preserved from the underlying node process.
set -u

# 2. Installer-written pin.
if [ -z "${PRISM_NODE:-}" ] && [ -f "$HOME/.claude/prism.env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.claude/prism.env" 2>/dev/null || true
fi

_prism_newest() {
  # Print newest matching path (version-sorted), or nothing.
  # $1 = glob pattern
  # shellcheck disable=SC2206
  local matches=( $1 )
  [ ${#matches[@]} -eq 0 ] && return 0
  [ -e "${matches[0]}" ] || return 0
  printf '%s\n' "${matches[@]}" | sort -V | tail -n1
}

# Runnable = exists, executable, AND actually runs. The `-x` bit is an FS
# permission flag; it does NOT catch a binary denied by Windows AppLocker/WDAC
# (PATH resolves, `-x` passes, exec fails). So verify by EXECUTION before
# selecting a fallback candidate — otherwise the wrapper could pick a blocked
# node and silently no-op EVERY hook ([[feedback-applocker-exe-detection]]).
_prism_runnable() {
  [ -n "$1" ] && [ -x "$1" ] && "$1" --version >/dev/null 2>&1
}

_prism_resolve_node() {
  # Hot path: an installer-written pin. Kept as a cheap -x check (NO per-hook
  # --version spawn) — the installer verified it at install time, and this
  # branch runs on every hook. The execution-verify below covers the unpinned
  # fallback paths where the AppLocker false-positive actually bites.
  if [ -n "${PRISM_NODE:-}" ] && [ -x "${PRISM_NODE}" ]; then
    printf '%s' "$PRISM_NODE"; return 0
  fi
  local cand
  cand=$(command -v node 2>/dev/null || true)
  if _prism_runnable "$cand"; then printf '%s' "$cand"; return 0; fi
  cand=$(_prism_newest "$HOME/.nvm/versions/node/*/bin/node")
  if _prism_runnable "$cand"; then printf '%s' "$cand"; return 0; fi
  cand=$(_prism_newest "$HOME/.fnm/node-versions/*/installation/bin/node")
  if _prism_runnable "$cand"; then printf '%s' "$cand"; return 0; fi
  if _prism_runnable "$HOME/.volta/bin/node"; then printf '%s' "$HOME/.volta/bin/node"; return 0; fi
  if command -v asdf >/dev/null 2>&1; then
    cand=$(asdf which node 2>/dev/null || true)
    if _prism_runnable "$cand"; then printf '%s' "$cand"; return 0; fi
  fi
  for cand in /opt/homebrew/bin/node /usr/local/bin/node; do
    if _prism_runnable "$cand"; then printf '%s' "$cand"; return 0; fi
  done
  return 1
}

NODE_BIN=$(_prism_resolve_node) || NODE_BIN=""
if [ -z "$NODE_BIN" ]; then
  exit 0
fi

NODE_DIR=$(dirname "$NODE_BIN")
case ":${PATH:-}:" in
  *":$NODE_DIR:"*) : ;;
  *) PATH="$NODE_DIR:${PATH:-}"; export PATH ;;
esac

exec "$NODE_BIN" "$@"
