---
name: prism-audit
description: Scan PRISM's own configuration surface for hygiene issues
---

Native security scanner for PRISM-specific files. PRISM-native grep-based
secret scan runs by default (patterns listed in Step 1 below). For deeper
coverage (100+ rules, taint analysis), optionally install AgentShield via
ECC and run ECC's /security-scan — but PRISM does NOT require ECC.

### Root-file check (runs first)

Flag any of these files at repo root (they often contain secrets and
should never be committed):
  .env, .env.*, credentials.json, *.pem, *.key, id_rsa*, *.pfx

If present and NOT gitignored: HIGH severity finding.

### Large-binary check (runs after secrets)

Flag any file > 50MB under the repo. Not a security issue, but a
hygiene/bloat finding (model weights, compiled artifacts, accidental
log dumps). Report as LOW severity.

## SCOPE (PRISM-owned paths only)

~/.claude/CLAUDE.md, settings.json, hooks/prism-*.mjs,
skills/prism-plan/references/roster.json, agents/*.md, agents/*/agent.md

{project}/CLAUDE.md, CLAUDE.local.md, .claude/.prism-state.json,
.claude/tools-scan.json, .mcp.json

## PROTOCOL

### Step 1 — Secret detection

Patterns (case-insensitive):
  - sk-[a-zA-Z0-9]{20,}, sk-proj-[a-zA-Z0-9-_]{100,}
  - sk-ant-[a-zA-Z0-9-_]{95,}
  - ghp_[a-zA-Z0-9]{36}
  - AKIA[0-9A-Z]{16}, ASIA[0-9A-Z]{16}
  - AIza[0-9A-Za-z_-]{35}
  - Bearer [a-zA-Z0-9-_\.]{20,}
  - -----BEGIN (RSA|OPENSSH|PGP|EC|DSA) PRIVATE KEY-----
  - eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+ (JWT)
  - postgres://.+:.+@, mysql://.+:.+@
  - sk_live_[a-zA-Z0-9]{24,}

For each match: file + line, redacted value, severity.

### Step 2 — PRISM surface integrity

Agent YAML:
- Required frontmatter: name, description, model, maxTurns
- If body references notebooklm_notebook_id, must be in frontmatter
- If agent directory exists, flat .md must also exist
- maxTurns > 0

Roster integrity:
- Valid JSON
- Each agent entry has name, version, created_date
- Verify agent files exist
- Flag orphaned entries

Hook health:
- Files exist and readable
- Executable bit (Unix) / no restrictions (Windows)
- node --check passes

### Step 3 — State file integrity
.prism-state.json: valid JSON, turns >= 0 and < 1000

### Step 4 — Misconfiguration checks
- Global CLAUDE.md contains "## PRISM" section
- settings.json MCP tokens not in plaintext
- CLAUDE.local.md gitignored (CRITICAL if not)
- .env in .gitignore (HIGH if not)

### Step 5 — Output report
Format:
  SECRETS    ✗ CRITICAL: N | ✗ HIGH: N | ⚠ LOW: N
  PRISM INTEGRITY  ✓/✗ per check
  CONFIGURATION    ✓/⚠/✗ per check
  SUMMARY: N issues (N critical, N high, N warnings)

### Step 6 — Save results
Write to ~/.claude/skills/prism-plan/references/audit-log.json

## FLAGS
/prism-audit              → full scan
/prism-audit --fix        → auto-fix safe issues (gitignore, dirs)
/prism-audit --quick      → secrets-only
/prism-audit --path <p>   → scan specific path
/prism-audit --severity high  → HIGH+ only

## EXIT CODES
2: CRITICAL | 1: HIGH | 0: clean

## RULES
- Never quote full secrets — always redact
- Never delete files — report, --fix only adds gitignore entries
- Never commit audit-log if secrets in findings

## NOT THIS
- Not a replacement for AgentShield (broader scanner — install via ECC if wanted)
- Not a code vulnerability scanner
- Not a credential rotation tool
