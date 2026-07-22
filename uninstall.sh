#!/usr/bin/env bash
# PRISM uninstaller — Mac/Linux + git-bash wrapper
#
# Usage:
#   bash uninstall.sh [options]
#   ./uninstall.sh [options]        (after chmod +x uninstall.sh)
#
# Options (forwarded to prism-installer.mjs):
#   --restore-backup <path>   Restore settings/roster from a backup directory
#   --quiet                   Suppress progress output
#   --home <path>             Override HOME directory
#
# Note: state files (.prism-*.jsonl, prism-policy.json, etc.) are always preserved.
# To fully clean, manually delete ~/.claude/.prism-* files after uninstall.
#
# Requirements:
#   - Node.js 18+ on PATH

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="$SCRIPT_DIR/tools/prism-installer.mjs"
MANIFEST_PATH="$SCRIPT_DIR/tools/install-manifest.json"
INSTALL_DEST="${HOME}/.claude"

# Read the canonical version from the manifest so the banner never drifts
# (mirrors install.ps1's existing fix for this same class of stale-banner bug).
PRISM_VERSION="unknown"
if [ -f "$MANIFEST_PATH" ] && command -v node >/dev/null 2>&1; then
  PRISM_VERSION="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).prism_version)" "$MANIFEST_PATH" 2>/dev/null || echo "unknown")"
fi

# ─── Banner ───────────────────────────────────────────────────────────────────
echo "┌─────────────────────────────────────────────────┐"
echo "│  PRISM Uninstaller v${PRISM_VERSION}                      │"
echo "│  Removing from: ${INSTALL_DEST}"
echo "└─────────────────────────────────────────────────┘"
echo ""

# ─── Node check ──────────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js is not on PATH. Install Node 18+ and try again."
  exit 1
fi

NODE_VERSION="$(node --version 2>/dev/null | sed 's/v//')"
NODE_MAJOR="$(echo "$NODE_VERSION" | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
  echo "ERROR: Node.js 18+ required (found v${NODE_VERSION})."
  exit 1
fi

# ─── Installer check ─────────────────────────────────────────────────────────
if [ ! -f "$INSTALLER" ]; then
  echo "ERROR: installer not found at: $INSTALLER"
  echo "  Make sure you are running this script from the PRISM repo root."
  exit 1
fi

# ─── Forward to Node installer ───────────────────────────────────────────────
exec node "$INSTALLER" uninstall "$@"
