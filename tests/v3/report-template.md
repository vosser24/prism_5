# PRISM v3.0 User-Journey Test Report

**Machine**: <!-- e.g., Windows 11, macOS 14, Ubuntu 22.04 -->
**Tester**: <!-- name / handle -->
**Date run**: <!-- ISO 8601 -->
**PRISM version under test**: <!-- from `grep prism_version ~/.claude/skills/prism-plan/references/update-log.json` -->
**Commit SHA**: <!-- git log -1 --format=%H -->

## Preconditions captured

```
Node version: <!-- node --version -->
Shell: <!-- bash/zsh/PowerShell version -->
ANTHROPIC_API_KEY in prism.env: <!-- yes/no -->
Claude Code version: <!-- claude --version -->
Plugins installed: <!-- /plugin list output -->
```

## Static suite — tests/v3/run-static.sh

Paste the final RESULT block from `/tmp/prism-v3-static.log`:

```
<!-- paste RESULT: N passed, M failed -->
```

Pass/fail per test (paste the full log or summarize):

```
<!-- paste the Category 1..14 PASS/FAIL lines -->
```

## Manual suite — tests/v3/run-claude.md

Fill in the Observed + Pass/Fail columns for every test you ran.

### Category 5 — Classifier routing

| ID | Expected | Observed tier/summon_panel/source | Pass/Fail | Notes |
|---|---|---|---|---|
| T5.1 | haiku / false | | | |
| T5.2 | sonnet / false | | | |
| T5.3 | opus / true | | | |
| T5.4 | opus / force_opus=true / force-opus | | | |
| T5.5 | opus / allowlist | | | |
| T5.6 | source=cache | | | |

### Category 6 — Guards

| ID | Expected | Observed | Pass/Fail | Notes |
|---|---|---|---|---|
| T6.1 | mutation-guard deny | | | |
| T6.2 | agent-model-guard nudge | | | |
| T6.3 | parent-dispatch-guard deny | | | |
| T6.4 | subagent Edit passes | | | |
| T6.5 | force override passes | | | |
| T6.6 | strict denies non-opus | | | |
| T6.7 | hard advisory on sonnet | | | |
| T6.8 | hard denies opus w/o model | | | |
| T6.9 | safety denies rm -rf / | | | |

### Category 7 — Roster & reconcile

| ID | Expected | Observed | Pass/Fail | Notes |
|---|---|---|---|---|
| T7.1 | new entry appears | | | |
| T7.2 | core agents skipped | | | |
| T7.3 | dual layout dedup | | | |
| T7.4 | re-reconcile no-op | | | |
| T7.5 | orphan flagged | | | |

### Category 8 — Resource-index

| ID | Expected | Observed | Pass/Fail | Notes |
|---|---|---|---|---|
| T8.1 | blocks empty, last_indexed null | | | |
| T8.2 | blocks populated after index | | | |
| T8.3 | dry-run no mutate | | | |
| T8.4 | skills-only refresh | | | |
| T8.5 | new plugin skill detected | | | |
| T8.6 | enrichment richer | | | |

### Category 9 — Blueprint-prompt

| ID | Expected | Observed | Pass/Fail | Notes |
|---|---|---|---|---|
| T9.1 | real specialists picked | | | |
| T9.2 | empty-index warning shown | | | |
| T9.3 | full workshop + challenges | | | |
| T9.4 | hands off to @master-orchestrator | | | |
| T9.5 | ≥2 challenges per position | | | |

### Category 10 — Parallel dispatch

| ID | Expected | Observed | Pass/Fail | Notes |
|---|---|---|---|---|
| T10.1 | 3 Agent() in one message | | | |
| T10.2 | parallel_opportunity hint logged | | | |
| T10.3 | Documented FAIL (gap) | | expected ❌ | target v2.10 |

### Category 12 — Cost/tier discipline

| ID | Expected | Observed | Pass/Fail | Notes |
|---|---|---|---|---|
| T12.1 | soft nudges | | | |
| T12.2 | hard: opus deny, sonnet nudge | | | |
| T12.3 | strict denies all non-opus w/o model | | | |
| T12.4 | migration notice once | | | |
| T12.5 | weekly rollup (optional) | | | |

### Category 13 — Skills invocation

| ID | Expected | Observed | Pass/Fail | Notes |
|---|---|---|---|---|
| T13.1 | ui-ux-pro-max auto-trigger | | | |
| T13.2 | blueprint auto on "plan" | | | |
| T13.3 | prism-chat on /panel | | | |
| T13.4 | Documented FAIL (gap) | | expected ❌ | target v2.10 |

### Category 15 — Windows-specific (Windows only)

| ID | Expected | Observed | Pass/Fail | Notes |
|---|---|---|---|---|
| T15.1 | cmd /c form in settings | | | N/A on POSIX |
| T15.2 | prism-exec.cmd present | | | |
| T15.3 | prism.env Windows path | | | |
| T15.4 | no BOM | | | |
| T15.5 | PowerShell write blocked | | | |

## Analyzer output — tests/v3/analyze-log.mjs

Paste output of:

```
node tests/v3/analyze-log.mjs ~/.claude/.prism-routing.jsonl
```

<!-- paste below -->

```

```

## Summary

- **Static**: _ passed, _ failed
- **Manual — required pass** (Cats 5,6,7,8,9,11,12,14,15 POSIX-or-Win-respective): _ / _
- **Manual — documented gap** (T10.3, T13.4): _ / 2 failed as expected
- **Overall verdict**: PASS / PASS-with-gaps / FAIL

## Notable findings / deviations

<!-- Anything unexpected. Edge cases found. Flaky tests. Environment issues. -->

## Recommended follow-ups

<!-- Based on what failed or was flaky, what should the next version fix? -->

---

**Attach**: the full `/tmp/prism-v3-static.log` and `~/.claude/.prism-routing.jsonl` (scrub any sensitive data first).
