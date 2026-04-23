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

## Reference Freshness
- Indexes older than 7 days: suggest refresh
- After database migration: auto-refresh schema index
- Agent hits error on missing table/column: trigger re-scan
