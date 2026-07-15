#!/usr/bin/env bash
# tests/v3/cli/acl-phase1-e2e.sh — F1.7 Phase-1 CLI end-to-end wrapper
# Delegates to the .mjs driver for cross-platform compatibility.
# Run: bash tests/v3/cli/acl-phase1-e2e.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec node "$SCRIPT_DIR/acl-phase1-e2e.mjs" "$@"
