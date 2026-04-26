#!/bin/sh
# PRISM one-command installer
# Automates INSTALL.md sections 0 (prereqs) -> 1 (clone) -> 2 (backup) ->
# 2.5 (node resolution + prism.env) -> 3 (manifest copy) -> 4 (install-merge)
# -> 5 (verify).
#
# POSIX-compatible: works under sh / bash / Git Bash on Linux, macOS, Windows.
# Idempotent: re-running on an existing install is safe (clone -> pull,
# backup -> new dated dir, merge -> no-op when fragment unchanged).

set -eu

# --- defaults --------------------------------------------------------------
PREFIX="${HOME}/PRISM"
BRANCH="${BRANCH:-}"
DRY_RUN=0
NO_BACKUP=0
REPO_URL="https://github.com/vosser24/PRISM"
CURRENT_STEP="startup"

# --- helpers ---------------------------------------------------------------
log() {
    printf '[install] %s\n' "$*"
}

die() {
    printf '[install] ERROR: %s\n' "$*" >&2
    exit 1
}

on_err() {
    rc=$?
    printf '[install] FAILED at step: %s (exit %d)\n' "$CURRENT_STEP" "$rc" >&2
    exit "$rc"
}
trap on_err EXIT

# Run a command, or print it under --dry-run.
run() {
    if [ "$DRY_RUN" -eq 1 ]; then
        printf '[install] DRY-RUN: %s\n' "$*"
    else
        # shellcheck disable=SC2048,SC2086
        eval "$*"
    fi
}

usage() {
    cat <<'USAGE'
PRISM installer — one-command install of the PRISM framework into ~/.claude/

Usage: bash scripts/install.sh [flags]

Flags:
  --dry-run         Print the plan without making any changes; exits 0.
  --prefix <dir>    Clone destination (default: ~/PRISM).
  --branch <name>   Git branch to clone (default: auto-detect from script's
                    repo if running from a clone, else 'main').
  --no-backup       Skip the ~/.claude/ backup step (NOT recommended).
  --help            Show this help and exit 0.

Steps performed:
  0  Prereq check (node>=18, python>=3.10, git)
  1  Clone or update the PRISM repo at <prefix>
  2  Backup ~/.claude/ to ~/.claude/backups/pre-prism-<timestamp>/
  2.5  Resolve node absolute path -> write ~/.claude/prism.env
  3  Copy framework files per manifest.json
  4  Merge settings.fragment.json into ~/.claude/settings.json
  5  Run scripts/verify.mjs to confirm a healthy install

Re-running is safe — every step is idempotent.
USAGE
}

# --- argparse --------------------------------------------------------------
while [ $# -gt 0 ]; do
    case "$1" in
        --help|-h)
            usage
            trap - EXIT
            exit 0
            ;;
        --dry-run)
            DRY_RUN=1
            shift
            ;;
        --no-backup)
            NO_BACKUP=1
            shift
            ;;
        --prefix)
            [ $# -ge 2 ] || die "--prefix requires a directory argument"
            PREFIX="$2"
            shift 2
            ;;
        --branch)
            [ $# -ge 2 ] || die "--branch requires a branch-name argument"
            BRANCH="$2"
            BRANCH_SOURCE="explicit"
            shift 2
            ;;
        *)
            printf '[install] unknown flag: %s\n' "$1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

# Expand a leading ~ in PREFIX (POSIX has no built-in tilde expansion when
# the value comes from a flag).
case "$PREFIX" in
    "~") PREFIX="$HOME" ;;
    "~/"*) PREFIX="$HOME/${PREFIX#~/}" ;;
esac

# Auto-detect branch from script's own git repo if not explicitly passed.
BRANCH_SOURCE="${BRANCH_SOURCE:-}"
if [ -z "$BRANCH" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  REPO_ROOT="$SCRIPT_DIR"
  while [ -n "$REPO_ROOT" ] && [ ! -d "$REPO_ROOT/.git" ]; do
    PARENT="$(dirname "$REPO_ROOT")"
    if [ "$PARENT" = "$REPO_ROOT" ]; then REPO_ROOT=""; break; fi
    REPO_ROOT="$PARENT"
  done
  if [ -n "$REPO_ROOT" ]; then
    DETECTED="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    if [ -n "$DETECTED" ] && [ "$DETECTED" != "HEAD" ]; then
      BRANCH="$DETECTED"
      BRANCH_SOURCE="auto-detected from script repo"
    fi
  fi
  if [ -z "$BRANCH" ]; then
    BRANCH="main"
    BRANCH_SOURCE="default; pass --branch to override"
  fi
fi

log "PRISM installer starting"
log "  prefix=$PREFIX"
log "  branch=${BRANCH} (${BRANCH_SOURCE})"
log "  dry-run=$DRY_RUN"
log "  no-backup=$NO_BACKUP"

# --- platform detection (for install hints + path style) -------------------
UNAME_S="$(uname -s 2>/dev/null || echo unknown)"
case "$UNAME_S" in
    Linux*)   PLATFORM="linux" ;;
    Darwin*)  PLATFORM="macos" ;;
    MINGW*|MSYS*|CYGWIN*) PLATFORM="windows" ;;
    *)        PLATFORM="unknown" ;;
esac
log "  platform=$PLATFORM"

# Print a per-platform install hint for a missing tool.
hint_install() {
    tool="$1"
    case "$PLATFORM" in
        linux)
            case "$tool" in
                node)   log "  hint: install via your distro (apt: 'sudo apt install nodejs') or use nvm: 'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash && nvm install 20'" ;;
                python) log "  hint: 'sudo apt install python3' (Debian/Ubuntu) or 'sudo dnf install python3' (Fedora)" ;;
                git)    log "  hint: 'sudo apt install git' (Debian/Ubuntu) or 'sudo dnf install git' (Fedora)" ;;
            esac
            ;;
        macos)
            case "$tool" in
                node)   log "  hint: 'brew install node' or use nvm" ;;
                python) log "  hint: 'brew install python@3.12' or download from python.org" ;;
                git)    log "  hint: 'brew install git' (or install Xcode Command Line Tools)" ;;
            esac
            ;;
        windows)
            case "$tool" in
                node)   log "  hint: install from https://nodejs.org/ or use nvm-windows" ;;
                python) log "  hint: install from https://www.python.org/downloads/windows/" ;;
                git)    log "  hint: install from https://git-scm.com/download/win" ;;
            esac
            ;;
        *)
            log "  hint: install '$tool' via your platform's package manager"
            ;;
    esac
}

# =========================================================================
# Step 0 — Prereq check
# =========================================================================
CURRENT_STEP="0/prereq-check"
log "step 0: checking prerequisites"

missing=0

# node >= 18
if ! command -v node >/dev/null 2>&1; then
    log "  MISSING: node (need >= 18)"
    hint_install node
    missing=$((missing + 1))
else
    node_ver="$(node --version 2>/dev/null | sed 's/^v//')"
    node_major="$(printf '%s\n' "$node_ver" | cut -d. -f1)"
    if [ -z "$node_major" ] || [ "$node_major" -lt 18 ] 2>/dev/null; then
        log "  MISSING: node >= 18 (found $node_ver)"
        hint_install node
        missing=$((missing + 1))
    else
        log "  ok: node $node_ver"
    fi
fi

# python >= 3.10  (try python3 first, then python)
PYTHON_BIN=""
if command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
    PYTHON_BIN="python"
fi

if [ -z "$PYTHON_BIN" ]; then
    log "  MISSING: python (need >= 3.10)"
    hint_install python
    missing=$((missing + 1))
else
    py_ver="$($PYTHON_BIN --version 2>&1 | awk '{print $2}')"
    py_major="$(printf '%s\n' "$py_ver" | cut -d. -f1)"
    py_minor="$(printf '%s\n' "$py_ver" | cut -d. -f2)"
    py_ok=0
    if [ "$py_major" = "3" ] && [ -n "$py_minor" ] && [ "$py_minor" -ge 10 ] 2>/dev/null; then
        py_ok=1
    elif [ -n "$py_major" ] && [ "$py_major" -gt 3 ] 2>/dev/null; then
        py_ok=1
    fi
    if [ "$py_ok" -eq 1 ]; then
        log "  ok: python $py_ver ($PYTHON_BIN)"
    else
        log "  MISSING: python >= 3.10 (found $py_ver)"
        hint_install python
        missing=$((missing + 1))
    fi
fi

# git
if ! command -v git >/dev/null 2>&1; then
    log "  MISSING: git"
    hint_install git
    missing=$((missing + 1))
else
    log "  ok: $(git --version 2>/dev/null)"
fi

if [ "$missing" -gt 0 ]; then
    die "$missing required tool(s) missing — see hints above; aborting"
fi

# =========================================================================
# Step 1 — Clone or update
# =========================================================================
CURRENT_STEP="1/clone-or-update"
log "step 1: clone or update repo at $PREFIX"

if [ -d "$PREFIX/.git" ]; then
    log "  found existing repo; fetching + checking out $BRANCH"
    run "git -C \"$PREFIX\" fetch --tags origin"
    run "git -C \"$PREFIX\" checkout \"$BRANCH\""
    run "git -C \"$PREFIX\" pull --ff-only origin \"$BRANCH\""
elif [ -d "$PREFIX" ] && [ "$(ls -A "$PREFIX" 2>/dev/null || true)" != "" ]; then
    die "$PREFIX exists and is not a git repo (and not empty); refusing to clobber"
else
    log "  cloning $REPO_URL -> $PREFIX (branch=$BRANCH)"
    run "git clone --branch \"$BRANCH\" \"$REPO_URL\" \"$PREFIX\""
fi

# =========================================================================
# Step 2 — Backup ~/.claude/
# =========================================================================
CURRENT_STEP="2/backup"
TS="$(date +%Y%m%d_%H%M%S)"
BACKUP_DIR="${HOME}/.claude/backups/pre-prism-${TS}"

if [ "$NO_BACKUP" -eq 1 ]; then
    log "step 2: SKIPPED (--no-backup) — not recommended"
    BACKUP_DIR="(skipped)"
else
    log "step 2: backing up existing ~/.claude/ to $BACKUP_DIR"
    run "mkdir -p \"$BACKUP_DIR\""
    # cp commands are best-effort: missing source files are fine.
    run "cp -p  \"$HOME/.claude/settings.json\"           \"$BACKUP_DIR/\" 2>/dev/null || true"
    run "cp -pr \"$HOME/.claude/hooks\"                   \"$BACKUP_DIR/\" 2>/dev/null || true"
    run "cp -pr \"$HOME/.claude/tools\"                   \"$BACKUP_DIR/\" 2>/dev/null || true"
    run "cp -p  \"$HOME/.claude/statusline-command.sh\"   \"$BACKUP_DIR/\" 2>/dev/null || true"
fi

# =========================================================================
# Step 2.5 — Resolve node absolute path, write ~/.claude/prism.env
# =========================================================================
CURRENT_STEP="2.5/node-resolution"
log "step 2.5: resolving node absolute path for prism.env"

NODE_ABS=""

# 1. command -v node
if [ -z "$NODE_ABS" ]; then
    cand="$(command -v node 2>/dev/null || true)"
    if [ -n "$cand" ] && [ -x "$cand" ]; then
        NODE_ABS="$cand"
        log "  resolved: command -v node -> $NODE_ABS"
    fi
fi

# 2. newest ~/.nvm/versions/node/*/bin/node
if [ -z "$NODE_ABS" ] && [ -d "$HOME/.nvm/versions/node" ]; then
    cand="$(ls -1d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1 || true)"
    if [ -n "$cand" ] && [ -x "$cand" ]; then
        NODE_ABS="$cand"
        log "  resolved: nvm -> $NODE_ABS"
    fi
fi

# 3. newest ~/.fnm/node-versions/*/installation/bin/node
if [ -z "$NODE_ABS" ] && [ -d "$HOME/.fnm/node-versions" ]; then
    cand="$(ls -1d "$HOME"/.fnm/node-versions/*/installation/bin/node 2>/dev/null | sort -V | tail -1 || true)"
    if [ -n "$cand" ] && [ -x "$cand" ]; then
        NODE_ABS="$cand"
        log "  resolved: fnm -> $NODE_ABS"
    fi
fi

# 4. ~/.volta/bin/node
if [ -z "$NODE_ABS" ] && [ -x "$HOME/.volta/bin/node" ]; then
    NODE_ABS="$HOME/.volta/bin/node"
    log "  resolved: volta -> $NODE_ABS"
fi

# 5. asdf which node
if [ -z "$NODE_ABS" ] && command -v asdf >/dev/null 2>&1; then
    cand="$(asdf which node 2>/dev/null || true)"
    if [ -n "$cand" ] && [ -x "$cand" ]; then
        NODE_ABS="$cand"
        log "  resolved: asdf -> $NODE_ABS"
    fi
fi

# 6. system locations
if [ -z "$NODE_ABS" ] && [ -x "/opt/homebrew/bin/node" ]; then
    NODE_ABS="/opt/homebrew/bin/node"
    log "  resolved: homebrew (arm64) -> $NODE_ABS"
fi
if [ -z "$NODE_ABS" ] && [ -x "/usr/local/bin/node" ]; then
    NODE_ABS="/usr/local/bin/node"
    log "  resolved: /usr/local/bin/node -> $NODE_ABS"
fi

if [ -z "$NODE_ABS" ]; then
    die "could not resolve an absolute node path despite step 0 passing — environment is inconsistent"
fi

PRISM_ENV="${HOME}/.claude/prism.env"
log "  writing $PRISM_ENV"

if [ "$DRY_RUN" -eq 1 ]; then
    log "  DRY-RUN: would write PRISM_NODE=$NODE_ABS to $PRISM_ENV"
else
    mkdir -p "${HOME}/.claude"
    # Single-quoted heredoc preserves backslashes verbatim — critical for
    # Windows paths like 'C:\Program Files\nodejs\node.exe'. We expand the
    # path via a positional parameter to avoid double-shell-interpretation.
    NODE_ABS_VAL="$NODE_ABS" sh -c '
        cat > "$1" <<EOF_PRISM_ENV
PRISM_NODE=${NODE_ABS_VAL}
EOF_PRISM_ENV
    ' _ "$PRISM_ENV"
fi

# =========================================================================
# Step 3 — Manifest-driven file copy
# =========================================================================
CURRENT_STEP="3/manifest-copy"
log "step 3: copying framework files per manifest.json"

MANIFEST="$PREFIX/manifest.json"
if [ ! -f "$MANIFEST" ]; then
    # In dry-run, the prefix may not be cloned yet — fall back to the
    # script's own source repo location so the count + plan output
    # still works without mutation.
    SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo "")"
    SOURCE_MANIFEST="$SCRIPT_DIR/../manifest.json"
    if [ "$DRY_RUN" -eq 1 ] && [ -f "$SOURCE_MANIFEST" ]; then
        log "  DRY-RUN: prefix not yet cloned — using source manifest at $SOURCE_MANIFEST"
        MANIFEST="$SOURCE_MANIFEST"
    else
        die "manifest.json not found at $MANIFEST"
    fi
fi

if [ "$DRY_RUN" -eq 1 ]; then
    # Quick count for the plan output without mutating anything.
    file_count="$(node -e '
        const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        process.stdout.write(String((m.files || []).length));
    ' "$MANIFEST" 2>/dev/null || echo "?")"
    log "  DRY-RUN: would copy $file_count manifest entries from $PREFIX -> ~/.claude/"
else
    # Use node to drive the copy: it can parse manifest.json, expand ~,
    # mkdir parents, hash-compare, and chmod +x — none of which is clean
    # in pure POSIX sh.
    PRISM_REPO="$PREFIX" PRISM_HOME="$HOME" node - <<'NODE_EOF'
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const repo = process.env.PRISM_REPO;
const home = process.env.PRISM_HOME;
const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'manifest.json'), 'utf8'));

function expand(p) {
    if (p.startsWith('~/')) return path.join(home, p.slice(2));
    if (p === '~') return home;
    return p;
}

function sha(file) {
    try {
        return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    } catch { return null; }
}

let copied = 0, skipped = 0, chmodded = 0;
for (const entry of manifest.files || []) {
    const src = path.join(repo, entry.src);
    const dest = expand(entry.dest);
    if (!fs.existsSync(src)) {
        console.warn(`[install]   WARN: missing source ${entry.src}`);
        continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const srcHash = sha(src);
    const destHash = sha(dest);
    if (srcHash && srcHash === destHash) {
        skipped++;
    } else {
        fs.copyFileSync(src, dest);
        copied++;
    }
    if (entry.chmod === '+x' && process.platform !== 'win32') {
        try {
            const st = fs.statSync(dest);
            fs.chmodSync(dest, st.mode | 0o111);
            chmodded++;
        } catch (e) {
            console.warn(`[install]   WARN: chmod +x failed for ${dest}: ${e.message}`);
        }
    }
}
console.log(`[install]   manifest: ${copied} copied, ${skipped} unchanged, ${chmodded} chmod +x`);
NODE_EOF
fi

# =========================================================================
# Step 4 — Run install-merge.mjs
# =========================================================================
CURRENT_STEP="4/install-merge"
log "step 4: deep-merging settings.fragment.json into ~/.claude/settings.json"

if [ ! -f "$PREFIX/scripts/install-merge.mjs" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
        log "  DRY-RUN: install-merge.mjs not at $PREFIX yet (would be after clone)"
    else
        die "scripts/install-merge.mjs missing in $PREFIX (incomplete checkout?)"
    fi
fi

if [ "$DRY_RUN" -eq 1 ]; then
    log "  DRY-RUN: would run: node $PREFIX/scripts/install-merge.mjs"
else
    ( cd "$PREFIX" && node scripts/install-merge.mjs )
fi

# =========================================================================
# Step 5 — Verify
# =========================================================================
CURRENT_STEP="5/verify"
log "step 5: verifying install"

if [ ! -f "$PREFIX/scripts/verify.mjs" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
        log "  DRY-RUN: verify.mjs not at $PREFIX yet (would be after clone)"
    else
        die "scripts/verify.mjs missing in $PREFIX (incomplete checkout?)"
    fi
fi

VERIFY_RC=0
if [ "$DRY_RUN" -eq 1 ]; then
    log "  DRY-RUN: would run: node $PREFIX/scripts/verify.mjs"
else
    # Don't let `set -e` kill us — we want to capture the exit code and
    # report what failed.
    set +e
    ( cd "$PREFIX" && node scripts/verify.mjs )
    VERIFY_RC=$?
    set -e
fi

# =========================================================================
# Final report
# =========================================================================
CURRENT_STEP="report"

# Read installed version out of manifest (best-effort).
VERSION="?"
if [ -f "$PREFIX/manifest.json" ] && command -v node >/dev/null 2>&1; then
    VERSION="$(node -e '
        try { process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version || "?"); }
        catch { process.stdout.write("?"); }
    ' "$PREFIX/manifest.json" 2>/dev/null || echo "?")"
fi

if [ "$DRY_RUN" -eq 1 ]; then
    log "----- DRY-RUN PLAN COMPLETE -----"
    log "no changes were made to your system"
    trap - EXIT
    exit 0
fi

if [ "$VERIFY_RC" -ne 0 ]; then
    log "----- INSTALL FAILED (verify exit $VERIFY_RC) -----"
    log "see scripts/verify.mjs output above for which checks failed"
    log "your backup is at: $BACKUP_DIR"
    trap - EXIT
    exit 1
fi

log "----- PRISM v$VERSION installed -----"
log "  backup:    $BACKUP_DIR"
log "  prism.env: $PRISM_ENV"
log "  repo:      $PREFIX"
log "  version:   $VERSION"
log "  next: open Claude Code and run /prism-health"

trap - EXIT
exit 0
