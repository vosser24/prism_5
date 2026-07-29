# Skill triggers — keyword → required-skill map

This file is consumed by `~/.claude/hooks/prism-skill-trigger-guard.mjs`
on every UserPromptSubmit. Each row maps a case-insensitive regex to a
skill the user likely needs but may not know is available. Severity
column reserved for v3.2 hard-mode escalation; v3.1 treats every match
as `nudge`.

Maintenance: keep regexes narrow (false positives erode trust). When
adding a row, also add a test case to `tests/v3/T13.4-skill-trigger.md`.

| Pattern (case-insensitive regex) | Required skill | Severity |
|---|---|---|
| `\b(ux\|design system\|accessibility\|wcag\|contrast)\b` | ui-ux-pro-max | nudge |
| `\b(plan\|architect\|strategy\|migrate\|build [a-z]+ system)\b` | blueprint-prompt | nudge |
| `\b(/panel\|panel review\|adversarial)\b` | prism-chat | nudge |
| `\b(seo\|search rank\|page speed\|core web vitals)\b` | greek-ecommerce-seo-specialist | nudge |
| `\b(notebook\|notebooklm\|research notes\|literature review)\b` | notebooklm | nudge |
| `\b(workflow\|orchestrat\|multi-step plan\|run the steps)\b` | workflow-orchestration | nudge |
| `\b(claude code\|hook\|subagent\|skill author\|claude\.md)\b` | claude-code-expert | nudge |
| `\b(security review\|threat model\|secrets scan\|vuln)\b` | security-review | nudge |
| `\b(simplify\|dedupe\|refactor for clarity\|clean up code)\b` | simplify | nudge |
| `\b(pull request\|review pr\|diff review)\b` | review | nudge |
| `\b(/prism-index\|index resources\|refresh roster)\b` | prism-discover | nudge |

## Format notes

- Patterns are JavaScript `RegExp` source strings. The `i` flag is added
  by the hook — do NOT include flags inline.
- Skills must match the slug under `~/.claude/skills/<slug>/SKILL.md` or
  a plugin-namespaced `plugin:slug` form.
- Severity values: `nudge` (advisory) — only one accepted in v3.1.
  Reserved future values: `warn`, `block`.
- Keep this list under ~25 rows; the hook reads it on every prompt and
  parses lazily but a long list erodes the <50ms latency target.
