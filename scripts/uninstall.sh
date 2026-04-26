#!/bin/sh
# PRISM one-command uninstaller
# Removes PRISM-owned files from ~/.claude/ and surgically edits
# ~/.claude/settings.json to drop PRISM hook entries / statusLine / env.
#
# POSIX-compatible: works under sh / bash / Git Bash on Linux, macOS, Windows.
# Idempotent: re-running with --purge is a safe no-op.
#
# DEFAULT MODE IS DRY-RUN — pass --purge to actually mutate the system.
# This is INVERTED vs install.sh because uninstall is destructive.

set -eu

# --- defaults --------------------------------------------------------------
PURGE=0
KEEP_MEMORY=0
NO_BACKUP=0
REINSTALL_REPO=""
CURRENT_STEP="startup"

CLAUDE_DIR="${HOME}/.claude"

# Per-category counters (for the inventory + final report)
CNT_HOOKS=0
CNT_COMMANDS=0
CNT_SKILLS=0
CNT_AGENTS=0
CNT_TOOLS=0
CNT_MISC=0
CNT_STATE=0
CNT_MEMORY=0

# Preserved-paths accumulator (newline-separated)
PRESERVED=""

# Paths (relative to ~/.claude) whose user-mutated state must be preserved
# across the prism-plan skill-dir deletion in step 6. These files live INSIDE
# the skill dir so the bulk delete would otherwise wipe them.
#   - roster.json     : agent registrations, notebooklm_notebook_id, task counts, escalation history
#   - update-log.json : version history
PRESERVE_PATHS="skills/prism-plan/references/roster.json
skills/prism-plan/references/update-log.json"

# Set when step 6 (pre) creates the temp dir; cleaned at end of run.
PRESERVE_TEMP=""

# Newline-separated list of relative paths actually restored, for the
# final report (and for dry-run preview accuracy).
PRESERVED_RESTORED=""

# --- helpers ---------------------------------------------------------------
log() {
    printf '[uninstall] %s\n' "$*"
}

die() {
    printf '[uninstall] ERROR: %s\n' "$*" >&2
    exit 1
}

on_err() {
    rc=$?
    printf '[uninstall] FAILED at step: %s (exit %d)\n' "$CURRENT_STEP" "$rc" >&2
    exit "$rc"
}
trap on_err EXIT

# Mutate-or-print helper. Honors PURGE: when 0 (default), print "would …";
# when 1, run the command for real.
run() {
    if [ "$PURGE" -eq 0 ]; then
        printf '[uninstall] DRY-RUN: would: %s\n' "$*"
    else
        # shellcheck disable=SC2048,SC2086
        eval "$*"
    fi
}

# Track a preserved (untouched) path for the final report.
preserve() {
    PRESERVED="${PRESERVED}$1
"
}

# Delete a single path if it exists, increment counter, log "would delete"
# in dry-run mode. Argument 1 is the counter variable name.
del_path() {
    cat_var="$1"
    target="$2"
    if [ -e "$target" ] || [ -L "$target" ]; then
        if [ "$PURGE" -eq 0 ]; then
            printf '[uninstall]   would delete: %s\n' "$target"
        else
            rm -rf -- "$target"
        fi
        # increment named counter portably
        eval "$cat_var=\$(( ${cat_var} + 1 ))"
    fi
}

# Delete every path matching a glob. Argument 1 is the counter variable.
# Argument 2 is a glob pattern. Safe under set -u (no matches -> no-op).
del_glob() {
    cat_var="$1"
    pattern="$2"
    # Use a subshell to avoid clobbering IFS / nullglob state.
    matches=""
    for p in $pattern; do
        # When the glob doesn't match, the literal pattern is yielded.
        [ -e "$p" ] || [ -L "$p" ] || continue
        matches="$matches $p"
    done
    [ -n "$matches" ] || return 0
    for p in $matches; do
        del_path "$cat_var" "$p"
    done
}

usage() {
    cat <<'USAGE'
PRISM uninstaller — removes PRISM from ~/.claude/

Usage: bash scripts/uninstall.sh [flags]

DEFAULT MODE IS DRY-RUN — no changes are made unless --purge is passed.

Flags:
  --purge                  Actually perform deletion (REQUIRED to mutate).
  --keep-memory            Preserve ~/.claude/.prism-sessions/ and .prism-rollups/.
  --no-backup              Skip the pre-uninstall backup (NOT recommended).
  --reinstall <repo-path>  After uninstall, run <repo-path>/scripts/install.sh.
  --help                   Show this help and exit 0.

Steps performed:
  1   Pre-flight: confirm ~/.claude/ exists
  2   Backup ~/.claude/ -> ~/.claude/backups/pre-uninstall-<ts>/
  3   Inventory: count files per category
  4   Remove PRISM hooks (~/.claude/hooks/prism-*.mjs, lib/prism-*)
  5   Remove PRISM commands (~/.claude/commands/prism-*.md)
  6   Remove 8 PRISM-owned skills (by exact name)
  7   Remove 3 PRISM core agents (by exact name)
  8   Remove PRISM tools (~/.claude/tools/prism-*, etc.)
  9   Remove misc files (statusline-command.sh, prism.env, plans)
  10  Remove ~/.claude/.prism-* state / cache / log dot-files
  11  Remove user memory (unless --keep-memory)
  12  Surgically edit ~/.claude/settings.json (filter PRISM hooks / statusLine / env)
  13  Final report
  14  If --reinstall, exec the installer

Re-running with --purge is a safe no-op (every step is idempotent).
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
        --purge)
            PURGE=1
            shift
            ;;
        --keep-memory)
            KEEP_MEMORY=1
            shift
            ;;
        --no-backup)
            NO_BACKUP=1
            shift
            ;;
        --reinstall)
            [ $# -ge 2 ] || die "--reinstall requires a repo-path argument"
            REINSTALL_REPO="$2"
            shift 2
            ;;
        *)
            printf '[uninstall] unknown flag: %s\n' "$1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

log "PRISM uninstaller starting"
if [ "$PURGE" -eq 0 ]; then
    log "  mode=DRY-RUN (no changes will be made; pass --purge to mutate)"
else
    log "  mode=PURGE (will actually delete files)"
fi
log "  keep-memory=$KEEP_MEMORY"
log "  no-backup=$NO_BACKUP"
[ -n "$REINSTALL_REPO" ] && log "  reinstall-repo=$REINSTALL_REPO"

# =========================================================================
# Step 1 — Pre-flight
# =========================================================================
CURRENT_STEP="1/preflight"
log "step 1: pre-flight"

if [ ! -d "$CLAUDE_DIR" ]; then
    die "$CLAUDE_DIR does not exist — nothing to uninstall"
fi
log "  ok: $CLAUDE_DIR present"

# =========================================================================
# Step 2 — Backup
# =========================================================================
CURRENT_STEP="2/backup"
TS="$(date +%Y%m%d_%H%M%S)"
BACKUP_DIR="${CLAUDE_DIR}/backups/pre-uninstall-${TS}"

if [ "$NO_BACKUP" -eq 1 ]; then
    log "step 2: SKIPPED (--no-backup) — not recommended"
    BACKUP_DIR="(skipped)"
else
    log "step 2: backing up ~/.claude/ -> $BACKUP_DIR"
    run "mkdir -p \"$BACKUP_DIR\""
    # Copy every top-level entry except 'backups' itself (avoid recursion).
    # Use a portable for-loop over ls; -A includes dot-files but skips . and ..
    if [ "$PURGE" -eq 0 ]; then
        log "[uninstall] DRY-RUN: would: cp -pr <each ~/.claude/* except backups/> -> $BACKUP_DIR/"
    else
        for entry in $(ls -A "$CLAUDE_DIR" 2>/dev/null); do
            [ "$entry" = "backups" ] && continue
            cp -pr "$CLAUDE_DIR/$entry" "$BACKUP_DIR/" 2>/dev/null || true
        done
    fi
fi

# =========================================================================
# Step 3 — Inventory pass
# =========================================================================
CURRENT_STEP="3/inventory"
log "step 3: inventory (counts of PRISM-owned files in $CLAUDE_DIR)"

inv_count_glob() {
    pat="$1"
    n=0
    for p in $pat; do
        [ -e "$p" ] || [ -L "$p" ] || continue
        n=$(( n + 1 ))
    done
    printf '%d' "$n"
}

inv_count_path() {
    [ -e "$1" ] || [ -L "$1" ] && printf '1' || printf '0'
}

INV_HOOKS=$(( $(inv_count_glob "$CLAUDE_DIR/hooks/prism-*.mjs") \
            + $(inv_count_glob "$CLAUDE_DIR/hooks/lib/prism-*.mjs") \
            + $(inv_count_glob "$CLAUDE_DIR/hooks/lib/prism-exec.sh") \
            + $(inv_count_glob "$CLAUDE_DIR/hooks/lib/prism-exec.cmd") ))
INV_COMMANDS=$(inv_count_glob "$CLAUDE_DIR/commands/prism-*.md")

# 8 PRISM-owned skills (skills can live as dirs or .md files).
PRISM_SKILLS="prism-plan prism-discover prism-chat blueprint-prompt workflow-orchestration claude-code-expert notebooklm video-production"
INV_SKILLS=0
for s in $PRISM_SKILLS; do
    if [ -e "$CLAUDE_DIR/skills/$s" ] || [ -e "$CLAUDE_DIR/skills/$s.md" ]; then
        INV_SKILLS=$(( INV_SKILLS + 1 ))
    fi
done

# 3 core agents.
PRISM_AGENTS="master-orchestrator.md agent-factory.md prism-updater.md"
INV_AGENTS=0
for a in $PRISM_AGENTS; do
    if [ -e "$CLAUDE_DIR/agents/$a" ]; then
        INV_AGENTS=$(( INV_AGENTS + 1 ))
    fi
done

INV_TOOLS=$(( $(inv_count_glob "$CLAUDE_DIR/tools/prism-*") \
            + $(inv_count_glob "$CLAUDE_DIR/tools/lib/prism-*.mjs") ))
[ -e "$CLAUDE_DIR/tools/subagent-summary.py" ] && INV_TOOLS=$(( INV_TOOLS + 1 ))
[ -e "$CLAUDE_DIR/tools/prism-monitor" ] && INV_TOOLS=$(( INV_TOOLS + 1 ))

INV_MISC=0
[ -e "$CLAUDE_DIR/statusline-command.sh" ] && INV_MISC=$(( INV_MISC + 1 ))
[ -e "$CLAUDE_DIR/prism.env" ] && INV_MISC=$(( INV_MISC + 1 ))
INV_MISC=$(( INV_MISC + $(inv_count_glob "$CLAUDE_DIR/plans/prism-*.md") ))

INV_STATE=$(inv_count_glob "$CLAUDE_DIR/.prism-*")

INV_MEMORY=0
[ -e "$CLAUDE_DIR/.prism-sessions" ] && INV_MEMORY=$(( INV_MEMORY + 1 ))
[ -e "$CLAUDE_DIR/.prism-rollups" ] && INV_MEMORY=$(( INV_MEMORY + 1 ))

log "  hooks            : $INV_HOOKS"
log "  commands         : $INV_COMMANDS"
log "  skills (of 8)    : $INV_SKILLS"
log "  agents (of 3)    : $INV_AGENTS"
log "  tools            : $INV_TOOLS"
log "  misc             : $INV_MISC"
log "  state dot-files  : $INV_STATE"
log "  memory entries   : $INV_MEMORY"

INV_TOTAL=$(( INV_HOOKS + INV_COMMANDS + INV_SKILLS + INV_AGENTS + INV_TOOLS + INV_MISC + INV_STATE + INV_MEMORY ))
log "  --- inventory total: $INV_TOTAL ---"

if [ "$INV_TOTAL" -eq 0 ]; then
    log "  nothing PRISM-owned found — uninstall is a no-op"
fi

# =========================================================================
# Step 4 — Hooks
# =========================================================================
CURRENT_STEP="4/hooks"
log "step 4: removing PRISM hooks"
del_glob CNT_HOOKS "$CLAUDE_DIR/hooks/prism-*.mjs"
del_glob CNT_HOOKS "$CLAUDE_DIR/hooks/lib/prism-*.mjs"
del_glob CNT_HOOKS "$CLAUDE_DIR/hooks/lib/prism-exec.sh"
del_glob CNT_HOOKS "$CLAUDE_DIR/hooks/lib/prism-exec.cmd"

# =========================================================================
# Step 5 — Commands
# =========================================================================
CURRENT_STEP="5/commands"
log "step 5: removing PRISM commands"
del_glob CNT_COMMANDS "$CLAUDE_DIR/commands/prism-*.md"

# =========================================================================
# Step 6 (pre) — Preserve user-mutated data inside prism-plan
# =========================================================================
# CRITICAL: roster.json + update-log.json live inside skills/prism-plan/
# and would be wiped by the recursive skill-dir delete below. Copy them
# to a temp preserve dir BEFORE deletion; restore AFTER all PRISM removal.
CURRENT_STEP="6pre/preserve-user-data"
PRESERVE_TEMP="${TMPDIR:-/tmp}/prism-uninstall-preserve-${TS}"
log "step 6 (pre): preserving user-mutated data inside prism-plan"
preserved_count=0
# IFS=newline to iterate the multi-line PRESERVE_PATHS string portably.
OLD_IFS="$IFS"
IFS='
'
for rel in $PRESERVE_PATHS; do
    [ -n "$rel" ] || continue
    abs="$CLAUDE_DIR/$rel"
    if [ -f "$abs" ]; then
        if [ "$PURGE" -eq 0 ]; then
            log "  PRESERVE: would copy $abs -> $PRESERVE_TEMP"
        else
            mkdir -p "$PRESERVE_TEMP/$(dirname "$rel")"
            cp -p "$abs" "$PRESERVE_TEMP/$rel"
            preserved_count=$(( preserved_count + 1 ))
        fi
    fi
done
IFS="$OLD_IFS"
if [ "$preserved_count" -gt 0 ]; then
    log "  preserved $preserved_count user-data file(s) to $PRESERVE_TEMP"
fi

# =========================================================================
# Step 6 — Skills (8 by exact name)
# =========================================================================
CURRENT_STEP="6/skills"
log "step 6: removing PRISM-owned skills (by exact name)"
for s in $PRISM_SKILLS; do
    del_path CNT_SKILLS "$CLAUDE_DIR/skills/$s"
    del_path CNT_SKILLS "$CLAUDE_DIR/skills/$s.md"
done

# =========================================================================
# Step 7 — Core agents (3 by exact name)
# =========================================================================
CURRENT_STEP="7/agents"
log "step 7: removing PRISM core agents (by exact name)"
for a in $PRISM_AGENTS; do
    del_path CNT_AGENTS "$CLAUDE_DIR/agents/$a"
done

# =========================================================================
# Step 8 — Tools
# =========================================================================
CURRENT_STEP="8/tools"
log "step 8: removing PRISM tools"
del_glob CNT_TOOLS "$CLAUDE_DIR/tools/prism-*"
del_glob CNT_TOOLS "$CLAUDE_DIR/tools/lib/prism-*.mjs"
del_path CNT_TOOLS "$CLAUDE_DIR/tools/subagent-summary.py"
del_path CNT_TOOLS "$CLAUDE_DIR/tools/prism-monitor"

# =========================================================================
# Step 9 — Misc
# =========================================================================
CURRENT_STEP="9/misc"
log "step 9: removing misc PRISM files"
del_path CNT_MISC "$CLAUDE_DIR/statusline-command.sh"
del_path CNT_MISC "$CLAUDE_DIR/prism.env"
del_glob CNT_MISC "$CLAUDE_DIR/plans/prism-*.md"

# =========================================================================
# Step 10 — State dot-files
# =========================================================================
CURRENT_STEP="10/state"
log "step 10: removing ~/.claude/.prism-* state files"
# Iterate explicitly so we can skip memory dirs when --keep-memory.
for p in "$CLAUDE_DIR"/.prism-*; do
    [ -e "$p" ] || [ -L "$p" ] || continue
    base="$(basename "$p")"
    if [ "$KEEP_MEMORY" -eq 1 ]; then
        case "$base" in
            .prism-sessions|.prism-rollups)
                log "  preserving (--keep-memory): $p"
                preserve "$p"
                continue
                ;;
        esac
    else
        # Memory dirs are handled in step 11, not here.
        case "$base" in
            .prism-sessions|.prism-rollups)
                continue
                ;;
        esac
    fi
    del_path CNT_STATE "$p"
done

# =========================================================================
# Step 11 — User memory
# =========================================================================
CURRENT_STEP="11/memory"
if [ "$KEEP_MEMORY" -eq 1 ]; then
    log "step 11: SKIPPED (--keep-memory)"
    [ -e "$CLAUDE_DIR/.prism-sessions" ] && preserve "$CLAUDE_DIR/.prism-sessions"
    [ -e "$CLAUDE_DIR/.prism-rollups" ]  && preserve "$CLAUDE_DIR/.prism-rollups"
else
    log "step 11: removing user memory"
    del_path CNT_MEMORY "$CLAUDE_DIR/.prism-sessions"
    del_path CNT_MEMORY "$CLAUDE_DIR/.prism-rollups"
fi

# =========================================================================
# Step 12 — Surgically edit settings.json
# =========================================================================
CURRENT_STEP="12/settings-edit"
SETTINGS="$CLAUDE_DIR/settings.json"
log "step 12: surgically editing $SETTINGS"

if [ ! -f "$SETTINGS" ]; then
    log "  no settings.json found — skipping"
else
    # Always run the node filter — in dry-run mode it prints "would write"
    # without touching the file. We pass PURGE in via env so node knows.
    PRISM_SETTINGS="$SETTINGS" PRISM_PURGE="$PURGE" node - <<'NODE_EOF'
const fs = require('fs');
const file = process.env.PRISM_SETTINGS;
const purge = process.env.PRISM_PURGE === '1';

let raw;
try { raw = fs.readFileSync(file, 'utf8'); }
catch (e) { console.error(`[uninstall]   ERROR reading ${file}: ${e.message}`); process.exit(1); }

let cfg;
try { cfg = JSON.parse(raw); }
catch (e) { console.error(`[uninstall]   ERROR parsing ${file}: ${e.message}`); process.exit(1); }

const PRISM_CMD_RX = /(prism-exec\.(sh|cmd))|(prism-[a-z0-9-]+\.mjs)/i;

let removedHookEntries = 0;
let removedHookGroups = 0;

// Filter hook arrays. Settings shape:
//   "hooks": { "<EventName>": [ { matcher?: "...", hooks: [ { type, command, ... } ] } ] }
if (cfg.hooks && typeof cfg.hooks === 'object') {
    for (const eventName of Object.keys(cfg.hooks)) {
        const groups = cfg.hooks[eventName];
        if (!Array.isArray(groups)) continue;
        const newGroups = [];
        for (const group of groups) {
            if (!group || !Array.isArray(group.hooks)) {
                newGroups.push(group);
                continue;
            }
            const beforeN = group.hooks.length;
            const filteredHooks = group.hooks.filter(h => {
                if (!h || typeof h.command !== 'string') return true;
                if (PRISM_CMD_RX.test(h.command)) {
                    removedHookEntries++;
                    return false;
                }
                return true;
            });
            const afterN = filteredHooks.length;
            void beforeN; void afterN;
            if (filteredHooks.length === 0) {
                removedHookGroups++;
                continue; // drop the group entirely
            }
            group.hooks = filteredHooks;
            newGroups.push(group);
        }
        if (newGroups.length === 0) {
            delete cfg.hooks[eventName];
        } else {
            cfg.hooks[eventName] = newGroups;
        }
    }
    if (Object.keys(cfg.hooks).length === 0) {
        delete cfg.hooks;
    }
}

// statusLine: drop if it points to PRISM (statusline-command.sh or prism.env).
let removedStatusLine = false;
if (cfg.statusLine) {
    const sl = cfg.statusLine;
    const cmd = (sl && typeof sl === 'object' && typeof sl.command === 'string') ? sl.command : '';
    if (cmd && /(statusline-command\.sh|prism\.env|prism-)/i.test(cmd)) {
        delete cfg.statusLine;
        removedStatusLine = true;
    }
}

// env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: drop only when it's the sole env entry.
let removedEnvKey = false;
if (cfg.env && typeof cfg.env === 'object') {
    const keys = Object.keys(cfg.env);
    if (keys.length === 1 && keys[0] === 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS') {
        delete cfg.env;
        removedEnvKey = true;
    }
}

const summary = `[uninstall]   settings.json: removed ${removedHookEntries} hook entries, ${removedHookGroups} empty groups, statusLine=${removedStatusLine}, env-key=${removedEnvKey}`;
console.log(summary);

const out = JSON.stringify(cfg, null, 2) + '\n';

if (purge) {
    fs.writeFileSync(file, out);
    console.log(`[uninstall]   wrote ${file}`);
} else {
    console.log(`[uninstall]   DRY-RUN: would write ${file} (${out.length} bytes)`);
}
NODE_EOF
fi

# =========================================================================
# Step 12 (post) — Restore preserved user data
# =========================================================================
# Move the temp-preserved roster.json + update-log.json back into the
# (just-deleted) skills/prism-plan/references/ directory, recreating
# the parent path as needed.
CURRENT_STEP="12post/restore-user-data"
log "step 12 (post): restoring preserved user data"
OLD_IFS="$IFS"
IFS='
'
for rel in $PRESERVE_PATHS; do
    [ -n "$rel" ] || continue
    src="$PRESERVE_TEMP/$rel"
    dst="$CLAUDE_DIR/$rel"
    if [ "$PURGE" -eq 0 ]; then
        # In dry-run, nothing was copied to the temp dir; preview based on
        # the live source file presence so the report is accurate.
        if [ -f "$CLAUDE_DIR/$rel" ]; then
            log "  RESTORE: would restore $dst"
            PRESERVED_RESTORED="${PRESERVED_RESTORED}${rel}
"
        fi
    else
        if [ -f "$src" ]; then
            mkdir -p "$(dirname "$dst")"
            cp -p "$src" "$dst"
            log "  restored: $dst"
            PRESERVED_RESTORED="${PRESERVED_RESTORED}${rel}
"
        fi
    fi
done
IFS="$OLD_IFS"
# Cleanup the preservation temp dir.
if [ "$PURGE" -eq 1 ] && [ -n "$PRESERVE_TEMP" ] && [ -d "$PRESERVE_TEMP" ]; then
    rm -rf -- "$PRESERVE_TEMP"
fi

# =========================================================================
# Step 13 — Final report
# =========================================================================
CURRENT_STEP="13/report"
log "----- UNINSTALL REPORT -----"
if [ "$PURGE" -eq 0 ]; then
    log "  MODE: DRY-RUN — nothing was deleted"
    log "  re-run with --purge to actually remove the files above"
else
    log "  MODE: PURGE — files removed"
fi
log "  hooks      removed: $CNT_HOOKS"
log "  commands   removed: $CNT_COMMANDS"
log "  skills     removed: $CNT_SKILLS"
log "  agents     removed: $CNT_AGENTS"
log "  tools      removed: $CNT_TOOLS"
log "  misc       removed: $CNT_MISC"
log "  state      removed: $CNT_STATE"
log "  memory     removed: $CNT_MEMORY"
log "  backup at: $BACKUP_DIR"

if [ -n "$PRESERVED" ]; then
    log "  preserved paths:"
    # printf each preserved line under the report
    printf '%s' "$PRESERVED" | while IFS= read -r line; do
        [ -n "$line" ] && log "    - $line"
    done
else
    log "  preserved paths: (none)"
fi

if [ -n "$PRESERVED_RESTORED" ]; then
    log "  preserved (user data):"
    printf '%s' "$PRESERVED_RESTORED" | while IFS= read -r rel; do
        [ -n "$rel" ] && log "    - $rel"
    done
else
    log "  preserved (user data): (none)"
fi

# =========================================================================
# Step 14 — Optional reinstall
# =========================================================================
CURRENT_STEP="14/reinstall"
if [ -n "$REINSTALL_REPO" ]; then
    REINSTALL_SCRIPT="$REINSTALL_REPO/scripts/install.sh"
    if [ ! -f "$REINSTALL_SCRIPT" ]; then
        die "--reinstall: $REINSTALL_SCRIPT not found"
    fi
    log "step 14: chaining reinstall via $REINSTALL_SCRIPT --no-backup"
    if [ "$PURGE" -eq 0 ]; then
        log "  DRY-RUN: would exec: bash $REINSTALL_SCRIPT --no-backup"
    else
        trap - EXIT
        exec bash "$REINSTALL_SCRIPT" --no-backup
    fi
fi

trap - EXIT
exit 0
