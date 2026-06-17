#!/usr/bin/env sh
# nlm-call.sh — hard-timeout wrapper for every NotebookLM invocation (F13).
# Guarantees: the call returns within $NLM_TIMEOUT seconds and leaves no
# lingering child (timeout --kill-after SIGKILLs a wedged process). On timeout
# the wrapper exits 3 and prints a Tier-3 fallback marker on stderr so the
# factory degrades gracefully instead of hanging.
NLM_BIN="${NLM_BIN:-notebooklm}"
NLM_TIMEOUT="${NLM_TIMEOUT:-90}"      # per-call wall clock (s)
NLM_KILL_AFTER="${NLM_KILL_AFTER:-10}"
timeout --kill-after="${NLM_KILL_AFTER}s" "${NLM_TIMEOUT}s" "$NLM_BIN" "$@"
rc=$?
if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
  echo "NotebookLM call timed out after ${NLM_TIMEOUT}s — degrading to Tier-3 (Opus). No retry." 1>&2
  exit 3
fi
exit "$rc"
