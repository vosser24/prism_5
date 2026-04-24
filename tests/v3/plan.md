# PRISM v3.0 User-Journey Test Suite

Comprehensive test coverage for every user-facing journey in PRISM, organized by the verdict categories from the v2.9.1 release retrospective.

## Scope

Exercise every claim PRISM makes about what it does. Distinguish:

- **Works reliably** — should pass every test
- **Half-works** — should pass with documented caveats  
- **Doesn't work yet** — should fail visibly (known gap, documented target version)

A failing test in "doesn't work yet" is an honest result, not a regression — the test proves the gap still exists.

## Test inventory — 15 categories, 62 tests

### Category 1 — Install & Upgrade [automated]

| ID | Journey | Expected |
|---|---|---|
| T1.1 | Fresh install from empty `~/.claude/` | install-merge succeeds; verify reports 77/77 manifest entries |
| T1.2 | Re-run install-merge immediately | Idempotent no-op; `UPDATE_LOG_STAMPED=false` (already at version) |
| T1.3 | Downgrade `update-log.json` to old version, re-run | `UPDATE_LOG_STAMPED=true (bumped X → Y)` |
| T1.4 | install-merge without `node` on PATH | Fails with clear error, no partial state |
| T1.5 | install-merge from wrong cwd | `FATAL: settings.fragment.json not found` |
| T1.6 | install-merge preserves existing user hooks | User-authored `prism-my-custom.mjs` survives |

### Category 2 — Verify [automated]

| ID | Journey | Expected |
|---|---|---|
| T2.1 | Fresh install → `verify.mjs` | Exit 0, 77 manifest entries + infra OK |
| T2.2 | Delete one manifest file, re-verify | Exit 1, names the missing file |
| T2.3 | Corrupt `settings.json` → verify | Reports unreadable, exits 1 |
| T2.4 | Run `verify.mjs` outside repo (no manifest) | Falls back to hardcoded list, warns |
| T2.5 | `verify.mjs --manifest <path>` | Reads specified manifest |

### Category 3 — Health [automated + 1 manual]

| ID | Journey | Expected |
|---|---|---|
| T3.1 | Clean install → `/prism-health` inside Claude Code | Exit 0, no warnings |
| T3.2 | Create orphan agent file → `/prism-health` | Flags roster drift |
| T3.3 | Set update-log.json to old version → `/prism-health` | Flags version lag |
| T3.4 | Remove ANTHROPIC_API_KEY → `/prism-health` | Notes keyword-floor mode |

### Category 4 — Audit [automated + manual]

| ID | Journey | Expected |
|---|---|---|
| T4.1 | Fresh install → `/prism-audit` | Exit 0 or 1 with only low-severity findings |
| T4.2 | Drop `.env` with secret into repo → audit | Flags CRITICAL secret + gitignore |
| T4.3 | Agent missing `maxTurns` → audit | Flags MEDIUM |
| T4.4 | `## ATLAS` heading in global CLAUDE.md → audit | Flags LOW |

### Category 5 — Classifier routing [manual, needs Claude Code session]

| ID | Prompt | Expected sentinel.tier / summon_panel |
|---|---|---|
| T5.1 | `what does SIGTERM mean` | haiku / false |
| T5.2 | `write a debounce function in TypeScript` | sonnet / false |
| T5.3 | `design a rate limiter for multi-region SaaS with 10k tenants` | opus / true |
| T5.4 | `!opus-force: check the git log` | opus / any; sentinel.force_opus=true |
| T5.5 | `/prism-health` | opus (allowlist); source=allowlist |
| T5.6 | Re-send T5.1 within 24h | source=cache |

### Category 6 — Guards [manual, Claude Code runtime]

| ID | Journey | Expected |
|---|---|---|
| T6.1 | On sonnet turn, parent Opus attempts `Edit` on a file | mutation-guard denies, nudges to dispatch |
| T6.2 | On sonnet turn, parent Opus `Agent({...})` without `model` field | agent-model-guard nudges (soft) |
| T6.3 | On novel turn (summon_panel=true), parent Opus attempts any work tool | parent-dispatch-guard denies, requires `@master-orchestrator` |
| T6.4 | Subagent spawned via dispatch performs `Edit` | Passes (three-path bypass works) |
| T6.5 | `!opus-force: <edit command>` | All guards pass through |
| T6.6 | `PRISM_MODEL_GUARD=strict` + non-opus Agent without model | Denies (strict preserves old-hard) |
| T6.7 | `PRISM_MODEL_GUARD=hard` + sonnet Agent without model | Advisory only (v2.9.1 softened) |
| T6.8 | `PRISM_MODEL_GUARD=hard` + opus Agent without model | Denies |
| T6.9 | Bash pattern `rm -rf /` | safety denies |

### Category 7 — Roster & reconcile [manual]

| ID | Journey | Expected |
|---|---|---|
| T7.1 | Create `~/.claude/agents/test-specialist.md` manually → `/prism-roster --reconcile` | Entry added to roster.json |
| T7.2 | `agent-factory`, `master-orchestrator`, `prism-updater` on disk | Skipped by reconcile (core) |
| T7.3 | Both flat `foo.md` and subdir `foo/agent.md` | Both discovered, dedup by name |
| T7.4 | Re-run reconcile | No-op, "already reconciled" |
| T7.5 | `/prism-roster` (no args) | Displays table, flags orphans |

### Category 8 — Resource-index [manual]

| ID | Journey | Expected |
|---|---|---|
| T8.1 | Fresh install → read roster.json | `skills/tools/mcps = {}`, `last_indexed: null` |
| T8.2 | `/prism-index` | Populates skills (user+plugin+prism), tools, mcps |
| T8.3 | `/prism-index --dry-run` | Reports what would change, no write |
| T8.4 | `/prism-index --skills-only` | Only refreshes skills block |
| T8.5 | Install a new plugin skill → `/prism-index` | Appears in new index |
| T8.6 | `/prism-index --enrich` | Keywords/trigger_phrases richer than default |

### Category 9 — Blueprint-prompt [manual]

| ID | Journey | Expected |
|---|---|---|
| T9.1 | "Plan a migration from X to Y" on populated index | Blueprint invoked, real specialists picked |
| T9.2 | Same prompt on empty index | Emits "hallucination risk HIGH" notice, fallback personas labeled |
| T9.3 | Advisory task ("analyze this approach") | Full workshop, adversarial review visible |
| T9.4 | Execution-heavy task | Alignment pass only, hands off to @master-orchestrator |
| T9.5 | Panel output includes ≥2 challenges per position | Doctrine honored (currently doctrine-only, not enforced) |

### Category 10 — Parallel dispatch [manual, KNOWN GAP]

| ID | Journey | Expected |
|---|---|---|
| T10.1 | Plan with `[pgroup=1]` on 3 tasks, dispatched | One assistant message with 3 Agent() blocks |
| T10.2 | Hook emits parallel-opportunity hint | Advisory nudge visible in stderr |
| T10.3 | Sequential dispatch of pgroup=1 tasks | **Currently not blocked** (known gap — target v2.10 parallel-guard) |

### Category 11 — Stale-state recovery [automated]

| ID | Journey | Expected |
|---|---|---|
| T11.1 | Create stale sentinel, delete, restart | Next prompt writes fresh sentinel |
| T11.2 | Corrupt tier-cache, delete | Classifier doesn't crash, rebuilds |
| T11.3 | Tier-1 clean (delete transient state) | Roster/memory/settings preserved |

### Category 12 — Cost/tier discipline [manual]

| ID | Journey | Expected |
|---|---|---|
| T12.1 | `PRISM_MODEL_GUARD=soft` (default) | All modes advisory |
| T12.2 | `PRISM_MODEL_GUARD=hard` (v2.9.1 semantics) | Deny only opus+no-model |
| T12.3 | `PRISM_MODEL_GUARD=strict` | Deny any non-opus without model |
| T12.4 | v2.9.1 migration notice | Fires once on first run; flag file written |
| T12.5 | Weekly rollup classifier calibration | Flags pgroup_violation events (soft) |

### Category 13 — Skills invocation [manual, KNOWN GAP]

| ID | Journey | Expected |
|---|---|---|
| T13.1 | "UX audit of this page" with ui-ux-pro-max installed | Skill auto-activates via Claude's description match |
| T13.2 | Prompt contains "plan" or "strategy" | blueprint-prompt auto-activates |
| T13.3 | Prompt contains "/panel" or "PRISM this" | prism-chat auto-activates |
| T13.4 | Prompt mentions SEO but SEO specialist not invoked | **Currently not forced** (known gap — target v2.10) |

### Category 14 — Backup safety [automated]

| ID | Journey | Expected |
|---|---|---|
| T14.1 | install-merge creates `backups/pre-prism-<ts>/` before write | Backup exists after upgrade |
| T14.2 | Missing `~/.claude/` → install handles gracefully | No crash, creates dir |
| T14.3 | `~/.claude/backups/` preserved across upgrades | Never cleared |
| T14.4 | roster.json → `.bak` copy before write (reconcile/index) | `.bak` exists after command |

### Category 15 — Windows-specific [manual, Windows only]

| ID | Journey | Expected |
|---|---|---|
| T15.1 | install-merge rewrites `bash ~/.claude/...` → `cmd /c "%USERPROFILE%\..."` | Windows commands in settings.json |
| T15.2 | `prism-exec.cmd` present + executable | Yes |
| T15.3 | `prism.env` with `C:\Program Files\nodejs\node.exe` path | Hook wrapper finds node |
| T15.4 | No BOM in hook-written JSON files | UTF-8 no BOM |
| T15.5 | Mutation-guard blocks PowerShell writes | Parent-context PS denied |

## How to run

### Full suite (human + automated, ~30 min)

```bash
cd /path/to/PRISM
bash tests/v3/run-all.sh            # runs static, prompts for manual
```

### Just automated (~2 min)

```bash
bash tests/v3/run-static.sh > /tmp/prism-v3-static.log 2>&1
echo "Exit: $?"
```

### Manual only (inside Claude Code)

Follow `tests/v3/run-claude.md` — paste each prompt, record outcome.

### Analyze the log

```bash
node tests/v3/analyze-log.mjs ~/.claude/.prism-routing.jsonl > v3-report.md
```

### Fill in the human-review report

Copy `tests/v3/report-template.md` → `v3-report-<date>.md`, fill in manual results, attach analyzer output.

## Pass criteria

- **Categories 1–4, 7, 8, 11, 14, 15** (the "works reliably" set) — 100% pass required.
- **Categories 5, 6, 9, 12** (classifier, guards, blueprint, cost) — 100% pass required.
- **Category 10 (parallel)** — T10.1 and T10.2 pass; T10.3 fail expected (documented gap).
- **Category 13 (skills)** — T13.1–T13.3 pass; T13.4 fail expected (documented gap).

Total expected: 60/62 pass, 2 documented-gap failures in Categories 10 + 13.

## What a failing test in categories 10/13 means

Not a regression. A proof that the gap still exists until v2.10 enforcement hooks ship (`prism-parallel-guard.mjs`, `prism-panel-guard.mjs`, skill-invocation advisory). When those ship, the expected results for T10.3 + T13.4 flip from "documented fail" to "pass".
