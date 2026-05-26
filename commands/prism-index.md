---
name: prism-index
description: Scan all installed agents, skills, tools, and MCPs and populate the unified resource-index in roster.json. Run to make the orchestrator and blueprint-prompt aware of resources that weren't created via agent-factory (plugin skills, user-installed skills, manually-imported agents, newly-added MCPs).
---

Usage:
  /prism-index                 → fast scan + index (deterministic keyword extraction)
  /prism-index --enrich        → same scan, plus Opus enrichment pass per resource (~$0.30, better keywords)
  /prism-index --dry-run       → report what WOULD be indexed without writing roster.json
  /prism-index --skills-only   → scan skills only (fastest, for quick refresh after installing a plugin)

## Purpose

PRISM's original discovery path was agent-factory — the heavyweight research-backed path that creates agents, registers them in `roster.json`, and spawns per-agent NotebookLM notebooks. That path covers agents only. Skills (user + plugin), installed tools (superpowers, uipro-cli), and MCP servers have never been indexed. Result: the orchestrator and blueprint-prompt cannot see 70–90% of a typical user's installed resources, so they hallucinate generic personas instead of dispatching to real specialists.

`/prism-index` fills that gap. It scans every resource on disk + every configured MCP, extracts domain tags and keywords, and writes them into the `skills` / `tools` / `mcps` sibling blocks alongside the existing `agents` block in `roster.json`. Blueprint-prompt Phase 2 and master-orchestrator's pre-dispatch step query all four blocks and prefer indexed specialists over hardcoded personas.

## PROTOCOL

### Step 1 — Read current roster and set backup

```
ROSTER = ~/.claude/skills/prism-plan/references/roster.json
BACKUP = ROSTER + ".bak"
```

Copy `ROSTER` to `BACKUP` before any write. Idempotent: overwrite any existing `.bak` — single-generation safety net.

If `roster.json` doesn't exist, create from schema v2.9.0 skeleton (empty `agents`, `skills`, `tools`, `mcps`, `index_meta`).

If `roster.schema_version` is below `"2.9.0"`, add the missing blocks (`skills`, `tools`, `mcps`, `index_meta`) without touching `agents`. Bump `schema_version` to `"2.9.0"`.

### Step 2 — Scan skills

Scan in this order and deduplicate by `name` (first match wins — once a name has been recorded by an earlier tier, later tiers MUST skip it):

0. **Plugin-installed PRISM skills**: scan `${CLAUDE_PLUGIN_ROOT}/skills/**/SKILL.md` (where `${CLAUDE_PLUGIN_ROOT}` is the env var Claude Code sets when running plugin-installed code). Tag `source: "prism"`. If `${CLAUDE_PLUGIN_ROOT}` is unset (manual install), this tier is empty and the scan falls through to tiers 1-3 unchanged.
1. **PRISM-owned skills (legacy manual-install layout)**: `~/.claude/skills/prism-*/SKILL.md` (and friends — `~/.claude/skills/blueprint-prompt/SKILL.md`, `~/.claude/skills/workflow-orchestration/SKILL.md`, `~/.claude/skills/claude-code-expert/SKILL.md`, `~/.claude/skills/notebooklm/SKILL.md`, `~/.claude/skills/video-production/SKILL.md`) — tag `source: "prism"`. Skip any name already recorded in tier 0.
2. **User skills**: all other `~/.claude/skills/*/SKILL.md` — tag `source: "user"`. Skip any name already recorded in tier 0 or 1.
3. **Plugin skills (non-PRISM)**: `~/.claude/plugins/*/skills/**/SKILL.md` — tag `source: "plugin:<plugin-dir-name>"`. Skip any name already recorded in tiers 0-2.

For each, parse YAML frontmatter between the first two `---` markers. Extract:

| Field | Source | Default |
|---|---|---|
| `name` | frontmatter `name:` | directory name |
| `description` | frontmatter `description:` (first 200 chars) | `""` |
| `domains` | explicit `domains:` or `core_domains:` array | inferred by keyword heuristic on description |
| `keywords` | keyword extraction (§4) | same |
| `trigger_phrases` | explicit `trigger_phrases:` array | inferred by §4 phrase extraction |

Write each entry to `roster.skills[<name>]` with schema from `_schema_example_skill`.

Skip files that fail YAML parse — report the path to the user at the end.

### Step 3 — Scan tools and MCPs

**Tools** — read `~/.claude/skills/prism-plan/references/tools-registry.md`. For each tool entry, probe install status:

- `superpowers` / `uipro-cli` — check `~/.claude/plugins/<name>` dir exists
- npm global tools — `command -v <tool>` non-interactive check
- Python tools — `which <tool>` or `python -c "import <pkg>"` as listed
- MCPs — see next block

Write to `roster.tools[<name>]` with `install_status` + `tier` + `domains` + `keywords`.

**MCPs** — read `~/.claude/settings.json` `mcpServers` and any `.claude.json` in the current cwd that has `mcpServers`. For each:

- `server_name` — the key in mcpServers
- `source` — which file declared it
- `status: "connected"` if MCP currently connected in this session (inferrable from MCP tool availability), else `"configured"`
- `domains` / `keywords` — best-effort from the server name + description in registry if known

Write to `roster.mcps[<name>]`.

### Step 4 — Keyword extraction (fast, deterministic)

For each skill/tool/MCP description, extract `keywords`:

1. Lowercase the description
2. Tokenize on whitespace + punctuation
3. Remove stopwords: `the a an is are be for to of in on at by with use used PROACTIVELY MUST when if and or but not will should can`
4. Remove generic Claude Code terms: `claude code skill agent tool command hook use`
5. Keep tokens ≥ 4 chars, OR tokens that appear in explicit `domains`/`core_domains`
6. Deduplicate, cap at 20 keywords

Extract `trigger_phrases`:

1. Regex for phrases following "Use when", "Trigger when", "PROACTIVELY for", "MUST BE USED when" — capture the clause up to next sentence boundary (5–10 words)
2. Cap at 5 phrases

If `--enrich` is specified: for each skill/tool/MCP, send full SKILL.md body (or registry entry) to Opus with this prompt template:

> Extract the 5–15 most specific keywords and 3–5 precise trigger phrases for this resource. Respond as JSON with keys `keywords` (array of strings) and `trigger_phrases` (array of strings). Skip generic Claude Code terms.
> Resource: <name>
> <body>

Merge enriched output into the entry (enriched keywords/phrases replace fast-extracted ones; `index_meta.enrichment: "opus"`).

### Step 5 — Preserve the agents block

**CRITICAL**: Do not modify `roster.agents`. Agent task-tracking, escalation state, and NotebookLM notebook IDs are owned by `agent-factory` and `/prism-roster --reconcile`. `/prism-index` only populates the sibling blocks.

If the user wants to refresh agent keywords based on updated frontmatter, use `/prism-roster --reconcile` or re-run `agent-factory` upgrades. Not this command.

### Step 5.5 — Derive `domain_groups` (v4.1 Phase B / Q9)

Build (or rebuild) the `roster.domain_groups` block from the now-current `agents` + `skills` blocks.

For every entry in `roster.agents` and `roster.skills`:

1. Collect domain tags from the entry's `core_domains` (agents) or `domains` (skills) array. Tags are normalized to lowercase, hyphen-separated (e.g., `"Data Eng"` → `"data-eng"`).
2. For each tag, ensure `roster.domain_groups[<tag>]` exists with `{agents: [], skills: [], agent_count: 0, skill_count: 0, last_indexed: "<ISO-now>"}`.
3. Append the entry name to the appropriate array (`agents[]` or `skills[]`). Skip duplicates.
4. After processing every entry, recompute `agent_count` + `skill_count` per group, dedupe arrays, and sort alphabetically for stable diffs.

Empty groups (zero agents + zero skills after dedup) are pruned. Underscore-prefixed schema-example keys are skipped.

`domain_groups` is fully derived — overwrite the previous block rather than merging. The schema example lives at `roster._schema_example_domain_group`.

### Step 6 — Write roster.json

Update `roster.index_meta`:

```json
{
  "last_indexed": "<ISO-now>",
  "indexer_version": "2.9.0",
  "enrichment": "none"  // or "opus" if --enrich
}
```

Write the file. Format with 2-space indent.

### Step 7 — Report

Print summary:

```
PRISM Index — 2026-04-24

Skills     : N indexed (P PRISM-owned, U user, X plugin)
Tools      : N indexed (I installed, A available)
MCPs       : N indexed (C connected, F configured)
Domain     : N groups derived ({top-3 by total count, e.g. "frontend (4), data (3), seo (2)"})

Agents preserved: N (use /prism-roster --reconcile to refresh agent entries)

Index: ~/.claude/skills/prism-plan/references/roster.json
Backup: same path + .bak

New since last index:
  - <list new skills / tools / MCPs>
Missing since last index:
  - <resources removed from disk since last scan>

Next steps:
  - Run /prism-roster to see the full catalogue
  - Orchestrator + blueprint-prompt will consult this index automatically on next panel assembly
  - Re-run /prism-index after installing new plugins or agents
```

Exit 0 on success. Exit 1 (with message) if any scan failed unrecoverably (e.g., `~/.claude/` not found).

## Safety rules

1. **Additive** for the `agents` block — never read-modify-write it here.
2. **Backup before write** — always copy `roster.json` to `.bak` first.
3. **Idempotent** — running twice with no disk changes produces identical output.
4. **Fail-open on parse errors** — one malformed SKILL.md skips that entry and continues; doesn't abort the whole scan.
5. **No API calls by default** — only `--enrich` spends money.

## What this command does NOT do

- Does NOT upgrade the agent roster. Use `/prism-roster --reconcile`.
- Does NOT research domains deeply. Use `agent-factory` for that.
- Does NOT enforce consultation of the index at dispatch time. That's blueprint-prompt + master-orchestrator + (optionally in v2.9.1) a `prism-panel-guard` hook.
- Does NOT auto-refresh on SessionStart by default. Consider adding as v2.9.2 if the manual cadence proves wrong.

## When to run

- After installing a new Claude Code plugin
- After manually creating an agent or skill outside agent-factory
- After adding an MCP server to settings.json
- On any new machine, once, after running install-merge
- Periodically (weekly?) if you install things regularly
- Always after `/prism-update`
