#!/usr/bin/env bash
# PRISM v4.4.0 installer — Mac/Linux + git-bash wrapper
#
# Usage:
#   bash install.sh [options]
#   ./install.sh [options]         (after chmod +x install.sh)
#
# Options (forwarded to prism-installer.mjs):
#   --dry-run         Simulate install; no filesystem changes
#   --no-backup       Skip backup of existing settings/roster
#   --quiet           Suppress progress output
#   --home <path>     Override HOME directory
#
# Requirements:
#   - Node.js 18+ on PATH
#   - Claude Code CLI

set -euo pipefail

PRISM_VERSION="4.4.0"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="$SCRIPT_DIR/tools/prism-installer.mjs"
INSTALL_DEST="${HOME}/.claude"

# ─── Banner ───────────────────────────────────────────────────────────────────
echo "┌─────────────────────────────────────────────────┐"
echo "│  PRISM Installer v${PRISM_VERSION}                        │"
echo "│  Install destination: ${INSTALL_DEST}"
echo "└─────────────────────────────────────────────────┘"
echo ""

# ─── Node check ──────────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js is not on PATH. Install Node 18+ and try again."
  echo "  https://nodejs.org/"
  exit 1
fi

NODE_VERSION="$(node --version 2>/dev/null | sed 's/v//')"
NODE_MAJOR="$(echo "$NODE_VERSION" | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
  echo "ERROR: Node.js 18+ required (found v${NODE_VERSION})."
  echo "  https://nodejs.org/"
  exit 1
fi

# ─── Installer check ─────────────────────────────────────────────────────────
if [ ! -f "$INSTALLER" ]; then
  echo "ERROR: installer not found at: $INSTALLER"
  echo "  Make sure you are running this script from the PRISM repo root."
  exit 1
fi

# ─── Forward to Node installer ───────────────────────────────────────────────
# Pass all script args through; add 'install' subcommand
exec node "$INSTALLER" install "$@"
