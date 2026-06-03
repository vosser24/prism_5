---
name: prism-doctor
description: Symptom-driven PRISM diagnostic + guided fix. Reads recent routing log, checks env, roster integrity, settings.json wiring, hook syntax. Reports per-symptom diagnostic + ONE proposed fix per finding. Confirms before applying any fix.
---

Symptom-driven diagnostic for PRISM. Unlike `/prism-health` (which catalogs
state), this command reads symptoms, proposes ONE fix per finding, and
confirms before applying anything. **READ-ONLY by default** — every write
requires an explicit `Y` from the user.

If `/prism-health` answers "what's wrong?", `/prism-doctor` answers
"how do I fix it?" — one symptom at a time.

## PROTOCOL

### Step 1 — Collect signals (parallel reads, no writes)

**Layout detection (NEW in v3.6.0)**: at the top of the report, print
the active install layout — `plugin-install` if `${CLAUDE_PLUGIN_ROOT}`
is set, otherwise `manual-install`. All hook/command/skill/agent
existence checks below MUST target the layout-appropriate path:

- Plugin-install: check `${CLAUDE_PLUGIN_ROOT}/hooks/prism-*.mjs`,
  `${CLAUDE_PLUGIN_ROOT}/commands/prism-*.md`,
  `${CLAUDE_PLUGIN_ROOT}/skills/*`, `${CLAUDE_PLUGIN_ROOT}/agents/*`.
  Reference files are still checked under
  `~/.claude/skills/prism-plan/references/` because the SessionStart
  bootstrap copies them to that user-scoped path (see symptom #10).
- Manual-install: existing checks against `~/.claude/hooks/`,
  `~/.claude/commands/`, `~/.claude/skills/`, `~/.claude/agents/`.

Run these in parallel where possible:

1. **Routing log tail** — last 50 events from `~/.claude/.prism-routing.jsonl`
   ```
   tail -n 50 ~/.claude/.prism-routing.jsonl 2>/dev/null
   ```
   If file missing: note as a symptom (router never ran or log was wiped).

2. **Node availability** — detect by EXECUTION: `node --version` (a bare
   `command -v node` only proves PATH resolution; AppLocker/WDAC can resolve the
   path while denying the binary — [[feedback-applocker-exe-detection]]). If
   `node --version` fails but the path resolves, report `blocked`, not missing.

3. **prism.env presence + content** — does `~/.claude/prism.env` exist
   and set `PRISM_NODE`? `prism.env` is an OPTIONAL node-resolution pin
   (step 2 of the `prism-exec` fallback chain). Only treat its absence as
   a symptom when node is otherwise unresolvable (signal #2 failed) — with
   `node` on PATH a missing pin is the normal healthy state. See #1 below.

4. **roster.json validity** — JSON-parse
   `~/.claude/skills/prism-plan/references/roster.json`. Is `agents` block
   non-empty? Are skills/tools/mcps blocks all empty? (All-empty resource
   index is a known symptom — see #2 below.)

5. **settings.json validity** — JSON-parse `~/.claude/settings.json`.
   Verify it has:
   - At least one `prism-*.mjs` hook entry
   - Hook commands routed through the `prism-exec` wrapper (not raw
     `node ~/.claude/hooks/...`)

6. **Hook syntax check** — `node --check` every prism hook in the
   active layout:
   ```
   # Plugin-install: HOOKS_DIR=${CLAUDE_PLUGIN_ROOT}/hooks
   # Manual-install: HOOKS_DIR=~/.claude/hooks
   for f in "$HOOKS_DIR"/prism-*.mjs; do
     node --check "$f" 2>&1 | head -1
   done
   ```
   All 13+ PRISM hooks must pass. Report each failure.

7. **Policy file (INFO-level)** — `~/.claude/prism-policy.json` exists?
   Note as INFO only — opt-in feature, absence is normal.

8. **Tier sentinel age** — `ls -la ~/.claude/.prism-turn-tier-*.json`.
   Any file with mtime > 1 hour old is stale.

9. **Routing log size** — `stat -c%s ~/.claude/.prism-routing.jsonl`.
   Threshold: 10 MB.

10. **Roster freshness** — for each agent in roster.json, check
    `last_upgraded` against today (2026-04-25 baseline; use `date` for
    real runs). Anything > 90 days = stale.

11. **Orphan agent files** — files in `~/.claude/agents/` not present
    as keys in `roster.agents` (skip core agents: `agent-factory`,
    `master-orchestrator`, `prism-updater`).

12. **Hard-mode env** — `${PRISM_MODEL_GUARD:-}`. If set to `hard`,
    confirm the user knows this is the v2.9.1+ default-deny mode.

13. **Bootstrap state validity** — if the current project has a
    `.claude/.prism-state.json` (the bootstrap state machine — distinct
    from the `.claude/.prism-turn-state.json` turn-counter), validate it:
    `node ~/.claude/tools/prism-state.mjs validate`. A `status:` other
    than `ok` means the state is corrupt or clobbered. If the file does
    not exist, the dir simply isn't a bootstrapped PRISM project — that
    is NOT a symptom; skip it (do not run `validate`, which reports
    `invalid_schema` for a missing file).

### Step 2 — Symptom → fix mapping

For each detected symptom, emit ONE proposal in this exact format:

```
🔍 Symptom: <one-line description>
   Evidence: <what was observed — file path, count, log excerpt>
   Likely cause: <diagnosis>
   Proposed fix: <exact command(s) — copy-pasteable>
   [Y/n] Apply fix?
```

**Never auto-apply.** Wait for `Y` before running any write. A bare
return, `n`, or anything else = defer.

If multiple symptoms share a root cause, present **one** fix that
addresses both, listing both symptoms above the single proposal.

### Step 3 — Symptoms covered (10 minimum)

#### 1. prism.env missing AND node unresolvable
**Detect:** `~/.claude/prism.env` does not exist **AND** `node --version`
fails (no `node` on PATH and no version-manager fallback resolves). If
`node` resolves, this is **not** a symptom — `prism.env` is an *optional*
node-resolution pin (step 2 of the `prism-exec` fallback chain; a bare
`node` on PATH is the best-case step 3). A missing pin with a working
`node` is the normal, healthy state — do not flag it.
**Cause:** `node` lives only in a version-manager shell that the
non-interactive hook subprocess doesn't see, and no install-time pin was
written.
**Fix:** Write the pin directly — there is no installer script for this
(the legacy shell installer was retired; nothing auto-writes the pin).
The file is a single `KEY=VALUE` line:
`PRISM_NODE=<absolute path to a working node>`. Find the path in your
interactive shell with `which node` (bash) or `(Get-Command node).Source`
(PowerShell), then create `~/.claude/prism.env` (prefer Claude Code's
Write tool — no BOM). Or set `PRISM_NODE` in your shell profile / Claude
Code settings `env` and skip the file entirely.

#### 2. Resource-index empty
**Detect:** roster.json has non-empty `agents` block but `skills`,
`tools`, AND `mcps` blocks are all `{}`.
**Cause:** `/prism-index` has never been run, so the orchestrator can
only see agents — no skills/tools/MCPs are routable.
**Fix:** From inside Claude Code:
```
/prism-index
```

#### 3. Stale tier sentinels
**Detect:** Any `~/.claude/.prism-turn-tier-*.json` with mtime > 1 hour.
**Cause:** Previous Claude Code session crashed or was force-killed
mid-turn, leaving sentinel files that block future tier transitions.
**Fix:** Close all Claude Code instances first, then:
```
rm ~/.claude/.prism-turn-tier-*.json
```

#### 4. Stale routing log size
**Detect:** `~/.claude/.prism-routing.jsonl` > 10 MB.
**Cause:** Log has not been rotated since install. Hot path append-only,
fine to truncate after archiving.
**Fix:**
```
mv ~/.claude/.prism-routing.jsonl \
   ~/.claude/.prism-routing.jsonl.$(date +%Y%m%d)
: > ~/.claude/.prism-routing.jsonl
```

#### 5. Hook syntax error
**Detect:** Any `~/.claude/hooks/prism-*.mjs` fails `node --check`.
**Cause:** Hook file corrupted by a partial install, manual edit, or
filesystem fault.
**Fix:** Re-run the canonical installer from the repo clone (re-writes
hooks and re-wires settings.json):
```
node tools/prism-installer.mjs update
```
Or roll back from the `.bak` if the installer kept one:
```
cp ~/.claude/hooks/prism-<name>.mjs.bak ~/.claude/hooks/prism-<name>.mjs
```

#### 6. Stale roster (90+ days)
**Detect:** Any agent in `roster.agents` has `last_upgraded` more than
90 days before today.
**Cause:** Agent definitions drift behind PRISM core — older prompts,
missing newer tool affordances.
**Fix:** Update individually or in bulk:
```
/prism-update                      # check all agents
agent-factory --upgrade @<name>    # one specific agent
```

#### 7. Settings.json missing prism-exec wrapper
**Detect:** `~/.claude/settings.json` has hook entries with raw
`node ~/.claude/hooks/...` instead of going through the `prism-exec`
wrapper.
**Cause:** Manual edit, or upgrade from a pre-wrapper PRISM version.
The wrapper is what loads `prism.env` into the subprocess — without it,
hooks cannot resolve `PRISM_NODE` reliably.
**Fix:** Re-run the canonical installer to prune raw entries and re-wire
every hook entry through the wrapper:
```
node tools/prism-installer.mjs update
```

#### 8. Orphan agent files
**Detect:** Files in `~/.claude/agents/` whose names are not keys in
`roster.agents` (excluding the three core agents).
**Cause:** Manual agent creation, import from another install, or an
`agent-factory` crash mid-creation.
**Fix:**
```
/prism-roster --reconcile
```
(Additive only — never modifies existing entries.)

#### 9. Hard-mode misconfig (v2.9.1+)
**Detect:** `PRISM_MODEL_GUARD=hard` is set in env or
`~/.claude/prism-policy.json`.
**Cause:** v2.9.1 introduced a BREAKING CONTRACT change — `hard` is now
default-deny (any unrouted call is blocked). Users upgrading from
≤2.9.0 expecting the old "strict but permissive" behavior will see
unexpected denials.
**Fix:** If you wanted the old behavior, switch to `strict`:
```
export PRISM_MODEL_GUARD=strict
```
Then read the v2.9.1 BREAKING CONTRACT note in `CHANGELOG.md` to
confirm `hard` vs. `strict` is what you actually want.

#### 10. PRISM bootstrap incomplete (v3.6.0+)
**Detect:** `${CLAUDE_PLUGIN_ROOT}` is set (plugin-install layout) BUT
`~/.claude/skills/prism-plan/references/tools-registry.md` is missing.
Equivalent symptom: any of the other bootstrapped reference files
(`adversarial-review.md`, `model-matrix.md`, `prompt-templates.md`,
`mcp-registry.md`) absent from that directory.
**Cause:** The SessionStart hook seeds these files on first plugin
session. If the seeding never ran (first install never started a
session, the hook crashed before reaching this step, or the bootstrap
flag-file was created without the copy completing), downstream skills
can't read their references.
**Fix:** Either restart Claude Code (the SessionStart hook will
re-bootstrap on the next launch — but only if the flag-file is
absent; if a previous run wrote the flag without copying, delete it
first):
```
rm -f ~/.claude/.prism-plugin-bootstrap-done-v3.6
```
Then restart Claude Code. Or copy manually from the plugin payload:
```
mkdir -p ~/.claude/skills/prism-plan/references
cp "${CLAUDE_PLUGIN_ROOT}"/skills/prism-plan/references/{adversarial-review.md,model-matrix.md,prompt-templates.md,tools-registry.md,mcp-registry.md} \
   ~/.claude/skills/prism-plan/references/
# roster.json: copy ONLY if not already present (preserves user data).
[ -f ~/.claude/skills/prism-plan/references/roster.json ] || \
   cp "${CLAUDE_PLUGIN_ROOT}/skills/prism-plan/references/roster.json" \
      ~/.claude/skills/prism-plan/references/roster.json
```

#### 11. Bootstrap state corrupt / clobbered
**Detect:** the project has `.claude/.prism-state.json` **and**
`node ~/.claude/tools/prism-state.mjs validate` reports a `status:`
other than `ok` (e.g. `invalid_schema` — missing `schema_version` /
`phases` / `project_slug`, BOM corruption, or unparseable JSON). If the
file does not exist this is NOT a symptom (the dir isn't a bootstrapped
project).
**Cause:** a pre-v5.1.3 turn-counter clobbered the bootstrap state, a
partial bootstrap, or a manual edit. Breaks `/prism-deep-dive --refresh`,
`/prism-sync`, and re-bootstrap across restarts.
**Fix:** re-synthesize the state from filesystem evidence, then
re-validate (expect `status: ok`):
```
node ~/.claude/tools/prism-state.mjs adopt
node ~/.claude/tools/prism-state.mjs validate
```

### Step 4 — Report format

After all symptoms have been processed (applied or deferred), print:

```
Doctor Report — <YYYY-MM-DD>

Symptoms found: N
Fixes proposed: M  (M ≤ N — some symptoms may share a fix)
Fixes applied: K   (after user confirmation)
Fixes deferred: J  (J = M − K)

Re-run /prism-doctor after applying fixes to confirm clean state.
```

If `N == 0`: print `No symptoms detected. PRISM looks healthy.` and exit.

## CONSTRAINTS

- **READ-ONLY by default.** No file is written, moved, or deleted unless
  the user has typed `Y` for that specific fix.
- **Each fix is independent.** Do not chain fixes — applying #5 must not
  cascade into applying #7 unless the user confirms #7 separately.
- **Shared root cause = single proposal.** If two symptoms share a single
  underlying cause, present ONE fix listing both symptoms above the
  proposal.
- **Never print secrets.** Never echo full `prism.env` contents — only
  the variable names present.
- **Idempotent.** Running `/prism-doctor` twice with no changes between
  runs must produce the same symptom list.

## NOT THIS

- Not a state catalog — use `/prism-health` for "what is the current
  state of every component".
- Not an audit — use `/prism-audit` for security findings.
- Not a benchmark — use `benchmarks.md` for performance.
- Not a roster manager — use `/prism-roster --reconcile` for orphan
  cleanup (this command only proposes it as a fix).

## EXIT CODES (for CI / scripted use)

- `0` — no symptoms found
- `1` — symptoms found, all fixes deferred
- `2` — symptoms found, at least one fix applied
- `3` — collection step itself failed (e.g. cannot read settings.json)
