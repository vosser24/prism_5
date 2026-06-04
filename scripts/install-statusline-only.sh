#!/usr/bin/env bash
# install-statusline-only.sh — standalone PRISM statusline installer
# Downloads statusline-command.sh from the public PRISM repo and wires it
# into ~/.claude/settings.json. No full PRISM install needed.
#
# Usage:
#   bash scripts/install-statusline-only.sh
#   curl -fsSL https://raw.githubusercontent.com/vosser24/prism_5/main/scripts/install-statusline-only.sh | bash
set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/vosser24/prism_5/main"
SRC_FILE="statusline-command.sh"
LOG_PREFIX="[install-statusline]"

log()  { printf '%s %s\n' "$LOG_PREFIX" "$*"; }
fail() { printf '%s ERROR: %s\n' "$LOG_PREFIX" "$*" >&2; exit 1; }

# ---------- prereq checks ----------
command -v node >/dev/null 2>&1 || fail "node is required but not found in PATH. Install Node.js and retry."
command -v curl >/dev/null 2>&1 || fail "curl is required but not found in PATH. Install curl and retry."

# ---------- resolve home ----------
# Prefer HOME; fall back to USERPROFILE (Git-Bash on Windows)
CLAUDE_HOME="${HOME:-${USERPROFILE:-}}"
[ -z "$CLAUDE_HOME" ] && fail "Cannot determine home directory (HOME and USERPROFILE both unset)."
CLAUDE_DIR="$CLAUDE_HOME/.claude"
DEST="$CLAUDE_DIR/$SRC_FILE"

log "Claude dir: $CLAUDE_DIR"

# ---------- create target directory ----------
if [ ! -d "$CLAUDE_DIR" ]; then
  mkdir -p "$CLAUDE_DIR"
  log "Created $CLAUDE_DIR"
fi

# ---------- download statusline script ----------
URL="$REPO_RAW/$SRC_FILE"
log "Downloading $URL"
curl -fsSL "$URL" -o "$DEST" || fail "Download failed: $URL"
chmod +x "$DEST"
log "Saved to $DEST (chmod +x)"

# ---------- patch settings.json via node ----------
log "Patching $CLAUDE_DIR/settings.json ..."
node -e '
  var fs   = require("fs");
  var path = require("path");
  var os   = require("os");
  var home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  var p    = path.join(home, ".claude", "settings.json");
  var cur  = {};
  if (fs.existsSync(p)) {
    try { cur = JSON.parse(fs.readFileSync(p, "utf8")); }
    catch(e) { process.stderr.write("[install-statusline] WARNING: could not parse existing settings.json — starting fresh.\n"); }
  }
  var dest = path.join(home, ".claude", "statusline-command.sh");
  cur.statusLine = {
    type:    "command",
    command: "bash " + dest,
    padding: 0
  };
  fs.writeFileSync(p, JSON.stringify(cur, null, 2) + "\n");
  console.log("[install-statusline] settings.json patched");
' || fail "node patch step failed"

# ---------- done ----------
log "Done. Restart Claude Code to activate the statusline."
exit 0
