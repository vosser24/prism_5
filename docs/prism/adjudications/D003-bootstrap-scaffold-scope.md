# D003 — Bootstrap scaffold scope (full project structure on first run)

**Status:** Locked
**Date:** 2026-05-19
**Decision owner:** PRISM core (user adjudication)
**Target release:** v3.10.0
**References:** D001-bootstrap-unification.md (parent), D002-v3.10-hooks-drift-scope.md

## Context

D001 §Phases lists the `/prism-bootstrap` structure phase as creating only:

```
.claude/{references,rules,agents,hooks}/
docs/prism/{adjudications,deviations,smoke}/
tasks/
.prism-state.json
```

During Phase 2 implementation the structure phase was built strictly to that
table. This produced a **regression** against the legacy `/prism-init`, whose
Step 2 also created `CLAUDE.local.md`, `.mcp.json`, a PRISM-tuned `.gitignore`,
and the `tasks/{todo,lessons-tactical,lessons-strategic}.md` seed files. D001
folded those into "the identity phase invokes /prism-init logic", but the
identity-phase prose only covered `CLAUDE.md`, so the remaining files were
created by neither phase.

A review of the `ChrisWiles/claude-code-showcase` reference repo and the
current (2026) Claude Code best-practice documentation also showed PRISM was
omitting two now-standard project-local directories: `.claude/skills/` and
`.claude/commands/`.

## Decision

**One `/prism-bootstrap` run produces the complete project scaffold — every
directory and seed file a PRISM project needs to track its own progress. No
second command, no manual fill-in.**

The structure phase (`tools/prism-bootstrap.mjs phase-structure`) creates:

**Directories (11):**
```
.claude/references/      .claude/rules/      .claude/agents/
.claude/hooks/           .claude/skills/     .claude/commands/
docs/prism/adjudications/   docs/prism/deviations/
docs/prism/lessons/         docs/prism/smoke/
tasks/
```

**Seed files (written only when absent — never overwritten):**
```
tasks/todo.md
tasks/lessons-tactical.md
tasks/lessons-strategic.md
.mcp.json                 ( {"mcpServers":{}} )
CLAUDE.local.md           (git-ignored personal notes stub)
```

**`.gitignore`:** created with the PRISM block, or — if a `.gitignore`
already exists — the PRISM block is appended once (idempotent; re-runs are
no-ops). The block git-ignores `CLAUDE.local.md`,
`.claude/settings.local.json`, `.claude/.prism-state.json`,
`.claude/.prism-telemetry-rollup.json`, `.claude/tools-scan.json`.

The conventions step (`phase-conventions`) continues to write
`.claude/rules/capture-conventions.md`.

`CLAUDE.md` itself remains the identity phase's responsibility (audit vs.
create), unchanged.

### New additions vs. D001's table

| Added | Why |
|-------|-----|
| `.claude/skills/` | Standard Claude Code convention — load-on-demand domain knowledge. |
| `.claude/commands/` | Standard Claude Code convention — project-local slash commands. |
| `docs/prism/lessons/` | `/prism-clean` archival target named in D002 §6; must exist. |
| `tasks/*.md` seeds | Restores legacy `/prism-init` behaviour; project progress tracking. |
| `.mcp.json` | Restores legacy `/prism-init`; MCP server config slot. |
| `CLAUDE.local.md` | Restores legacy `/prism-init`; personal gitignored notes. |
| `.gitignore` PRISM block | Restores legacy `/prism-init`; keeps state/telemetry/local files out of git. |

### Populating skills, agents, and global memory

Creating the directories is the structure phase's job. **Populating** them is
not:

- `.claude/agents/` and the roster — handled by the **roster phase**, which
  reconciles globally-installed PRISM agents into `roster.json`.
- `.claude/skills/` references and `.claude/references/` content — handled by
  the **discovery phase**.
- Global memory (`~/.claude/CLAUDE.md` rules, global lessons) — surfaced by
  the **identity phase** via CLAUDE.md `@import` pointers, not copied per
  project (copying would duplicate and drift).

This division keeps the structure phase deterministic and idempotent while
the LLM-judged phases do the population.

## Idempotency contract (unchanged guarantee, wider surface)

- Directories: `mkdir -p` semantics — existing dirs untouched.
- Seed files: written only when absent — an existing `todo.md`/`.mcp.json`/
  etc. is never overwritten.
- `.gitignore`: PRISM block appended at most once, keyed on the
  `# --- PRISM ---` marker.

## Risks

1. **`.mcp.json` collision** — a project may already use `.mcp.json`. Mitigated:
   never overwritten; only created when absent.
2. **`.gitignore` style mismatch** — appended block may not match a project's
   formatting conventions. Accepted: a fenced, clearly-marked block is the
   least-surprising approach.
3. **Empty directories not tracked by git** — `.claude/skills/` etc. start
   empty and git will not record them. Accepted: the discovery/roster phases
   populate them shortly after; no `.gitkeep` noise added.

## Lock

This adjudication is locked. It supersedes the structure-phase row of D001's
§Phases table. Subsequent changes require a new D### entry referencing this
one, D001, and D002.

## Related

- D001-bootstrap-unification.md — parent design (structure-phase table superseded here)
- D002-v3.10-hooks-drift-scope.md — `/prism-clean` archival target (`docs/prism/lessons/`)
- Reference: `ChrisWiles/claude-code-showcase` — `.claude/` layout survey
- Reference: Claude Code best-practices docs (code.claude.com/docs/en/best-practices)
- Superseded behaviour: legacy `/prism-init` Step 2 scaffold
