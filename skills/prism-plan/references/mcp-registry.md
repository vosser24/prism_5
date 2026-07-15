# MCP Server Registry
# Updated by @prism-updater. Check with: claude mcp list
# Last updated: 2026-06-25 (PRISM v6.0.2)

## Recommended by Domain
### E-Commerce: postgresql (essential), github, playwright (testing), brave-search
### Web Dev: github, playwright, supabase (if using), figma
### Data/Analytics: postgresql, brave-search
### General: brave-search (fills knowledge gaps with live data)

## Token Rules
- Tool Search ON by default (95% context reduction)
- 3-5 active MCPs is the sweet spot
- Disable playwright (100K+/page) when not testing
- Prefer project-scope (.mcp.json) over user-scope

---

## Tier 2 — General-purpose MCP servers (install on demand)

### Filesystem MCP (Anthropic official)
- Purpose: Access files and directories outside the current project
- Add: `claude mcp add --transport stdio filesystem -- npx -y @modelcontextprotocol/server-filesystem <allowed-path>`
- Auth: none (path-scoped)
- Keywords: access files outside project, cross-project file work, read other repos

### GitHub MCP (Anthropic official)
- Purpose: List/create issues, PRs, review code, search repositories
- Add: `claude mcp add --transport http github https://api.githubcopilot.com/mcp/` (requires PAT in env)
- Auth: `claude mcp login github` (OAuth) or set `GITHUB_PERSONAL_ACCESS_TOKEN` env
- Keywords: list issues, create PR, review this PR, search github for, open issue

### Context7 MCP (Upstash)
- Purpose: Live documentation lookup for libraries/frameworks — resolves "latest API for X"
- Add: `claude mcp add --transport http context7 https://mcp.context7.com/mcp`
- Auth: `claude mcp login context7`
- Keywords: latest docs for, use the X API, how does X v{N}, check the docs

### PostgreSQL MCP
- Purpose: Direct DB queries, schema inspection, migrations
- Add: `claude mcp add --transport stdio --env DATABASE_URL=<url> db -- npx -y @bytebase/dbhub`
- Auth: none beyond DATABASE_URL
- Keywords: query the database, show schema, run migration, insert into

## Auth management
- Login:  `claude mcp login <server-name>`   (opens browser OAuth flow)
- Logout: `claude mcp logout <server-name>`  (revokes stored token)
- List:   `claude mcp list`                  (shows all configured servers + auth status)
- Note: HTTP servers with OAuth store tokens in `~/.claude.json` under the server entry.
