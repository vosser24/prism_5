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

Run these in parallel where possible:

1. **Routing log tail** — last 50 events from `~/.claude/.prism-routing.jsonl`
   ```
   tail -n 50 ~/.claude/.prism-routing.jsonl 2>/dev/null
   ```
   If file missing: note as a symptom (router never ran or log was wiped).

2. **API key visibility (subprocess scope)** — what the hook subprocess
   sees, not just the parent shell:
   ```
   bash -lc 'echo "${ANTHROPIC_API_KEY:-MISSING}"' | sed 's/.\{4\}$/****/'
   ```
   Redact all but last 4 chars in output. Never print the full key.

3. **Node availability** — `command -v node` and `node --version`.

4. **prism.env presence + content** — does `~/.claude/prism.env` exist?
   Does it set `PRISM_NODE`? (Read but redact any `*_KEY=` lines.)

5. **roster.json validity** — JSON-parse
   `~/.claude/skills/prism-plan/references/roster.json`. Is `agents` block
   non-empty? Are skills/tools/mcps blocks all empty? (All-empty resource
   index is a known symptom — see #3 below.)

6. **settings.json validity** — JSON-parse `~/.claude/settings.json`.
   Verify it has:
   - At least one `prism-*.mjs` hook entry
   - Hook commands routed through the `prism-exec` wrapper (not raw
     `node ~/.claude/hooks/...`)

7. **Hook syntax check** — `node --check` every prism hook:
   ```
   for f in ~/.claude/hooks/prism-*.mjs; do
     node --check "$f" 2>&1 | head -1
   done
   ```
   All 13 PRISM hooks must pass. Report each failure.

8. **Policy file (INFO-level)** — `~/.claude/prism-policy.json` exists?
   Note as INFO only — opt-in feature, absence is normal.

9. **Routing source distribution (last 24h)** — bucket
   `.prism-routing.jsonl` events by `source`:
   `opus`, `sonnet-fallback`, `cache`, `keyword-floor`, `allowlist`,
   `force-opus`. Compute the dominant bucket — drives symptom #1.

10. **Tier sentinel age** — `ls -la ~/.claude/.prism-turn-tier-*.json`.
    Any file with mtime > 1 hour old is stale.

11. **Routing log size** — `stat -c%s ~/.claude/.prism-routing.jsonl`.
    Threshold: 10 MB.

12. **Roster freshness** — for each agent in roster.json, check
    `last_upgraded` against today (2026-04-25 baseline; use `date` for
    real runs). Anything > 90 days = stale.

13. **Orphan agent files** — files in `~/.claude/agents/` not present
    as keys in `roster.agents` (skip core agents: `agent-factory`,
    `master-orchestrator`, `prism-updater`).

14. **Hard-mode env** — `${PRISM_MODEL_GUARD:-}`. If set to `hard`,
    confirm the user knows this is the v2.9.1+ default-deny mode.

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

If multiple symptoms share a root cause (e.g. "no API source in log"
AND "all keyword-floor"), present **one** fix that addresses both,
listing both symptoms above the single proposal.

### Step 3 — Symptoms covered (10 minimum)

#### 1. Classifier in keyword-floor only
**Detect:** Most recent 10 events in `.prism-routing.jsonl` all have
`source=keyword-floor` (no Opus/Sonnet API hits in the window).
**Cause:** API key not visible to hook subprocess — router fell back
to keyword heuristics for every turn.
**Fix:**
```
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> ~/.claude/prism.env
chmod 600 ~/.claude/prism.env
```
Then restart Claude Code.

#### 2. prism.env missing
**Detect:** `~/.claude/prism.env` does not exist.
**Cause:** Install never completed §2.5 (prism.env bootstrap), or file
was deleted.
**Fix:** Re-run §2.5 of `INSTALL.md` from the PRISM repo:
```
cd ~/PRISM && bash scripts/bootstrap-prism-env.sh
```
(Auto-detects `node` path, writes `PRISM_NODE`, prompts for API key.)

#### 3. Resource-index empty
**Detect:** roster.json has non-empty `agents` block but `skills`,
`tools`, AND `mcps` blocks are all `{}`.
**Cause:** `/prism-index` has never been run, so the orchestrator can
only see agents — no skills/tools/MCPs are routable.
**Fix:** From inside Claude Code:
```
/prism-index
```

#### 4. Stale tier sentinels
**Detect:** Any `~/.claude/.prism-turn-tier-*.json` with mtime > 1 hour.
**Cause:** Previous Claude Code session crashed or was force-killed
mid-turn, leaving sentinel files that block future tier transitions.
**Fix:** Close all Claude Code instances first, then:
```
rm ~/.claude/.prism-turn-tier-*.json
```

#### 5. Stale routing log size
**Detect:** `~/.claude/.prism-routing.jsonl` > 10 MB.
**Cause:** Log has not been rotated since install. Hot path append-only,
fine to truncate after archiving.
**Fix:**
```
mv ~/.claude/.prism-routing.jsonl \
   ~/.claude/.prism-routing.jsonl.$(date +%Y%m%d)
: > ~/.claude/.prism-routing.jsonl
```

#### 6. Hook syntax error
**Detect:** Any `~/.claude/hooks/prism-*.mjs` fails `node --check`.
**Cause:** Hook file corrupted by a partial install, manual edit, or
filesystem fault.
**Fix:** Re-run install-merge from the repo:
```
cd ~/PRISM && bash scripts/install-merge.sh
```
Or roll back from the `.bak` if the install-merge tool kept one:
```
cp ~/.claude/hooks/prism-<name>.mjs.bak ~/.claude/hooks/prism-<name>.mjs
```

#### 7. Stale roster (90+ days)
**Detect:** Any agent in `roster.agents` has `last_upgraded` more than
90 days before today.
**Cause:** Agent definitions drift behind PRISM core — older prompts,
missing newer tool affordances.
**Fix:** Update individually or in bulk:
```
/prism-update                      # check all agents
agent-factory --upgrade @<name>    # one specific agent
```

#### 8. Settings.json missing prism-exec wrapper
**Detect:** `~/.claude/settings.json` has hook entries with raw
`node ~/.claude/hooks/...` instead of going through the `prism-exec`
wrapper.
**Cause:** Manual edit, or upgrade from a pre-wrapper PRISM version.
The wrapper is what loads `prism.env` into the subprocess — without it,
hooks cannot see the API key.
**Fix:** Re-run install-merge to prune raw entries and re-wire through
the wrapper:
```
cd ~/PRISM && bash scripts/install-merge.sh
```

#### 9. Orphan agent files
**Detect:** Files in `~/.claude/agents/` whose names are not keys in
`roster.agents` (excluding the three core agents).
**Cause:** Manual agent creation, import from another install, or an
`agent-factory` crash mid-creation.
**Fix:**
```
/prism-roster --reconcile
```
(Additive only — never modifies existing entries.)

#### 10. Hard-mode misconfig (v2.9.1+)
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
- **Each fix is independent.** Do not chain fixes — applying #6 must not
  cascade into applying #8 unless the user confirms #8 separately.
- **Shared root cause = single proposal.** If symptoms #1 (keyword-floor
  only) and a hypothetical "no API source in log" both stem from a
  missing API key, present ONE fix listing both symptoms.
- **Never print secrets.** Redact API keys to last 4 chars. Never echo
  full `prism.env` contents — only the variable names present.
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
