---
name: prism-discover
description: >
  Index project resources into compact reference files for cheap future recall.
  Use when user says "read my database", "scan codebase", "map APIs",
  "index schema", "discover resources", or /prism-discover.
  Never activate for other tasks.
---

# PRISM Discover — Resource Indexing

## Output Location (MANDATORY)
ALL output files go to: .claude/references/
NEVER use prism/discovery/, docs/, or any other path.
Create .claude/references/ if it doesn't exist.

## Output Format (MANDATORY)
Produce TWO files per resource:

1. **Compact index** → .claude/references/{resource}-index.md
   - Domain-grouped summary: what exists, key relationships, gotchas
   - Target: 200-500 tokens (cheap to load in future tasks)

2. **Full detail** → .claude/references/{resource}-full.md
   - Complete specification: types, constraints, sizes, indexes
   - Agents read specific sections on demand (never loaded fully)

## Step 0: Detect Connection Method (DO THIS FIRST — before asking user)

**Database discovery — check in this order:**
  1. FIRST: check available MCP tools for database access.
     Run a tool search or check /mcp for: postgres, supabase, mysql, database.
     If ANY database MCP is connected → use it directly. Do NOT ask user about connections.
  2. SECOND: if no database MCP, check .env, settings.py, .mcp.json for connection strings.
     If found → use it. Inform user which connection you found.
  3. ONLY IF NOTHING FOUND: ask user for connection method.

**Codebase discovery:**
  1. Check if github MCP is connected → use for repo-wide search + native tools
  2. Otherwise → native Read/Grep/Glob (always available)

**API discovery:**
  1. Check for OpenAPI/Swagger specs in repo
  2. Check if API MCP is connected
  3. Fall back to scanning route files

## Step 1: Scope Check
- If .claude/references/{resource}-index.md already exists: ask refresh or skip
- If resource is large (5+ schemas, 100+ tables): use parallel scanning
- If resource is small: single sequential scan

## Step 2: Scan (using best tool from Step 0)
- Use haiku-model subagents for scanning (cheap, fast)
- Prefer MCP tools over bash commands (faster, more reliable, no connection issues)
- Each subagent writes partial results to temp files

## Step 3: Merge and Write
- Merge all scan results into the two output files
- Add cross-domain relationships discovered during merge
- Register index in project CLAUDE.md under "## Reference Files"
- Present summary with key findings to user

## Scanning Strategy (pick the right approach per resource type)

### Database:
  SQL is already the parallelism layer — one query scans all schemas at once.
  PREFERRED: Write a single Python/psql script that queries pg_catalog,
  information_schema across ALL schemas in one pass. Then a second script
  to summarize into index + full files. Faster and cheaper than spawning
  multiple subagents with separate DB connections.
  Only use parallel subagents if: different databases on different hosts.

### Codebase (10+ top-level directories):
  File reading has no "SQL" equivalent — parallel subagents genuinely help.
  Group directories by domain (3-4 groups).
  Spawn haiku subagent per group via Task().
  Each reads its directories, writes partial map to temp file.
  Parent merges → cross-module dependencies → .claude/references/codebase-map.md

### APIs (20+ endpoints):
  HTTP calls are sequential bottlenecks — parallel subagents help.
  Group by resource/domain (3-4 groups).
  Spawn haiku subagent per group via Task().
  Each scans its endpoints, writes partial spec to temp file.
  Parent merges → cross-endpoint relationships → .claude/references/api-index.md

### Knowledge (adjudications + lessons):
  Pure local file scan — no MCP, no network. Single sequential pass (corpus
  is small: a few dozen D-files and session-lesson files at most).
  Runs: `node ~/.claude/tools/prism-knowledge-index.mjs rebuild --root <project>`
  Output is compact-only (.claude/references/knowledge-index.md); there is no
  "-full" counterpart — the D### adjudication files and YYYY-MM-DD-session.md
  lesson files ARE the full detail. Load the index for cheap recall; read
  individual D-files on demand.

### When to use parallel subagents:
  - Codebase: 10+ directories OR 50+ files → YES
  - APIs: 20+ endpoints → YES
  - Multiple databases on different hosts → YES
  - Single database: NO — use SQL queries instead (one script, one pass)
  - Small resources: NO — sequential is fine

## Resource Types
| Request | Index File | Full File |
|---------|-----------|-----------|
| "read my database" | .claude/references/db-index.md | .claude/references/db-schema-full.md |
| "scan codebase" | .claude/references/codebase-map.md | .claude/references/codebase-detail.md |
| "map APIs" | .claude/references/api-index.md | .claude/references/api-specs-full.md |
| "check infrastructure" | .claude/references/infra-index.md | .claude/references/infra-detail.md |
| "index knowledge" / "scan lessons" | .claude/references/knowledge-index.md | (no full file — the D-files/lessons ARE the detail) |

## Reference Freshness
- Indexes older than 7 days: suggest refresh
- After database migration: auto-refresh schema index
- Agent hits error on missing table/column: trigger re-scan

## Step 4: Subdomain detection + nested CLAUDE.md proposal (v2.6.0)

After writing the index and full files, do ONE pass to detect whether
this project has distinct subdomains that would benefit from their own
scoped `CLAUDE.md`. This is opt-in per subdomain — you propose, user
approves.

### Detection signals (a subdomain exists when ≥2 of these hold in a subdir)

- Distinct stack manifest: a nested `package.json`, `pyproject.toml`,
  `requirements.txt`, `go.mod`, `Cargo.toml`, `Gemfile`, `composer.json`,
  or `Dockerfile` at depth ≥1 that declares a DIFFERENT primary language
  or framework from the repo root.
- Distinct test runner: subdir has its own `pytest.ini`, `jest.config.*`,
  `vitest.config.*`, `playwright.config.*`, `.rspec`, etc. different from
  root's test runner.
- Distinct build/lint config: `.eslintrc`, `ruff.toml`, `rustfmt.toml`,
  `tsconfig.json` with different compilerOptions than root.
- Distinct service boundary: folder named `src/backend`, `src/frontend`,
  `services/<name>`, `apps/<name>`, `packages/<name>` in a workspaces-style
  repo.
- Distinct conventions in existing code: majority of files in the subdir
  use a language/framework different from root.

### Propose, don't impose

For each detected subdomain, ask the user ONCE (batched, not one-by-one):

```
Detected N potential subdomain(s) that may benefit from scoped CLAUDE.md files:

  1. src/backend/       (Python 3.11, FastAPI, pytest)   → recommend nested CLAUDE.md
  2. src/frontend/      (TypeScript, Next.js 15, vitest) → recommend nested CLAUDE.md
  3. packages/shared/   (TypeScript, no tests)           → probably not needed — too thin

Nested CLAUDE.md files are auto-loaded by Claude Code only when working in
their subdirectory — they reduce per-session context vs one monolithic
root CLAUDE.md. Each stays ≤100 lines, covers only subdomain-specific
rules (not project-wide ones).

Options per detected subdomain:
  [Y] Scaffold nested CLAUDE.md     — stack-specific conventions + test/lint commands
  [R] Write to .claude/references/  — keep detail out of CLAUDE.md chain entirely
  [N] Skip                          — root CLAUDE.md already suffices
  [all-Y] / [all-R] / [all-N]       — apply same choice to all detected

How would you like to proceed?
```

### Nested CLAUDE.md template (when user says Y)

Keep it tight (target: 60-100 lines). Structure:

```markdown
# <Subdomain Name> (<path>)

## Stack
- Language: <detected>
- Framework: <detected>
- Test runner: <detected>
- Linter: <detected>

## Build / Test / Lint
(exact commands for THIS subdomain — different from root)

## Conventions
(only rules that differ from project root — do NOT repeat root rules)

## Directory layout
(brief map of this subdomain's internal structure)

## Cross-subdomain boundaries
- What this subdomain CONSUMES from other parts of the project
- What it EXPOSES to other parts
- Contracts / type-sharing mechanism (shared package, OpenAPI, etc.)
```

### Non-goals for nested CLAUDE.md

- Do NOT duplicate PRISM Operating Rules from root (they cascade anyway).
- Do NOT duplicate project-wide conventions, coding standards, or stack
  rules shared across subdomains — those stay at root.
- Do NOT scaffold for micro-subdomains (<10 files, no distinct tooling).
- Do NOT create CLAUDE.md in `node_modules/`, `dist/`, `build/`,
  `.next/`, `__pycache__/`, or any gitignored path.

### Record the proposal

Write the proposal + outcome (Y/R/N per subdomain) to
`.claude/references/subdomain-map.md` so re-running `/prism-discover`
doesn't re-propose subdomains the user already declined.

## State of the nested-CLAUDE.md chain (health check)

`/prism-discover --check-claude-chain` walks the repo, reports every
CLAUDE.md file found, their token size, and any violations of the
lean-template rules:

- Root CLAUDE.md > 200 lines → warn: "detail should move to references/"
- Nested CLAUDE.md > 100 lines → warn: "split or move detail out"
- Content duplicated parent↔child → warn: "child repeats root rules"
- CLAUDE.md in excluded paths (node_modules, dist, etc.) → warn: "should not exist"

Report is non-blocking — user decides whether to trim.
