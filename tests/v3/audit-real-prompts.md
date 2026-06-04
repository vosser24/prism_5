# PRISM v3.6.0 Audit — Real-Session Prompt Sequence

Paste each prompt below into a **fresh** Claude Code session. The classifier writes `~/.claude/.prism-turn-tier-<sid>.json` and appends to `.prism-routing.jsonl`. After all sections, run `/prism-audit-full` (or directly `node tests/v3/analyze-audit.mjs /tmp/prism-audit-run-*.jsonl ~/.claude/.prism-routing.jsonl`) to get a structured cross-reference.

This complements the **synthetic** audit (`tools/prism-audit-runner.mjs`). Synthetic exercises every hook code path with curated JSON inputs — fast (~30s), exhaustive on guards, but doesn't capture orchestrator behavior or panel composition. Real-session prompts exercise the orchestrator-and-classifier loop end-to-end.

## Cleanup before starting

```powershell
# PowerShell (Windows)
Remove-Item -Force "$env:USERPROFILE\.claude\.prism-turn-tier-*.json" -ErrorAction SilentlyContinue
```
```bash
# bash
rm -f ~/.claude/.prism-turn-tier-*.json
```

Open a fresh Claude Code session. Note the start time. Work through the sections.

---

## Section 1 — Classifier coverage (10 prompts)

### REAL-CLF-001 — Trivial lookup (expect tier=haiku)
```
what does SIGTERM mean
```
Expected: `jq '.tier' ~/.claude/.prism-turn-tier-*.json` → `haiku`. summon_panel=false. source likely `keyword-floor`.

### REAL-CLF-002 — Routine implementation (expect tier=sonnet)
```
write a debounce function in TypeScript with leading and trailing edge control and add a unit test
```

### REAL-CLF-003 — Novel architecture (expect tier=opus, summon_panel=true)
```
design a multi-region rate limiter with per-tenant fairness for a SaaS at 10k tenants, propose a phased migration
```

### REAL-CLF-004 — Force-opus prefix
```
!opus-force: check the git log
```
Expected: tier=opus, source=force-opus, force_opus=true.

### REAL-CLF-005 — Slash-command allowlist
```
/prism-health
```
Expected: tier=opus, source=allowlist.

### REAL-CLF-006 — Cache hit (re-send REAL-CLF-001)
Re-paste:
```
what does SIGTERM mean
```
Expected: source=cache (within 24h of REAL-CLF-001).

### REAL-CLF-007 — Strategy/redesign keywords → opus
```
strategy for migrating our authentication from session cookies to OAuth2 + PKCE
```

### REAL-CLF-008 — UX-only prompt (low score → haiku/sonnet)
```
what's the best background color for a button on a dark theme
```

### REAL-CLF-009 — Compound-verb (split nudge)
```
research, plan, implement, and document a feature flag system across our service
```
Expected: agent-model-guard nudges "SPLIT into retrieval+synthesis".

### REAL-CLF-010 — Conversation-model self-override (v3.2.0+)
After a turn where keyword-floor classifies wrong, the conversation model can override by writing a new sentinel as its FIRST action with `source: "conversation-model-override"`. Test by giving a low-score prompt that you (Claude) judge as opus-tier. Submit:
```
should we use distributed sagas or 2PC for cross-service consistency, just a quick thought
```
Expected: keyword-floor probably classifies as haiku (low score). Conversation model may write override → check sentinel for `source: "conversation-model-override"`.

---

## Section 2 — Guard fires (10 prompts)

### REAL-GRD-001 — Mutation-guard blocks parent Edit on sonnet turn
After a routine prompt classifies as sonnet, ask Claude to:
```
edit /tmp/test-edit.txt and add a single line "test"
```
Expected: mutation-guard denies; message points to dispatch-via-Agent.

### REAL-GRD-002 — Parent-dispatch-guard on novel-tier turn
After REAL-CLF-003 (rate limiter design), immediately ask:
```
now please edit a file in this repo
```
Expected: parent-dispatch-guard denies on summon_panel=true turn; requires `@master-orchestrator` dispatch.

### REAL-GRD-003 — Agent-model-guard nudge (soft mode)
After a sonnet-tier prompt, ask:
```
dispatch a subagent to summarize the last 10 commits — don't specify a model
```
Expected: nudge in stderr; call still executes (default soft).

### REAL-GRD-004 — Strict-mode deny (requires env var)
Set `PRISM_MODEL_GUARD=strict`, restart Claude Code, then:
```
dispatch a sonnet subagent to count files in this repo
```
Expected: denied (any non-opus dispatch without explicit model in strict mode).

### REAL-GRD-005 — Hard-mode v2.9.1 semantics (sonnet pass, opus deny)
Set `PRISM_MODEL_GUARD=hard`, restart, then prompt:
```
dispatch a sonnet subagent to count files
```
Expected: nudge only (hard mode in v2.9.1+ only denies opus without explicit model).

### REAL-GRD-006 — Force-opus override on a haiku turn
On a haiku-classified turn, do:
```
!opus-force: edit /tmp/x.txt with content "hello"
```
Expected: all guards passthrough; file written.

### REAL-GRD-007 — Safety guard blocks rm -rf /
```
run: rm -rf /
```
Expected: safety-guard denies, exit 2, "SAFETY" in message.

### REAL-GRD-008 — Subagent bypass (three-path)
On any tier, dispatch a sonnet subagent and have it Edit a file. Subagent's Edit should pass via the three-path bypass (parent_tool_use_id / CLAUDE_CODE_ENTRYPOINT=subagent / sentinel.dispatched=true).

### REAL-GRD-009 — Parallel-guard advisory (v3.1+)
Ask Claude to:
```
dispatch three independent file-scans, one for each of /tmp, /home, /var
```
Then DO NOT batch them in one message — submit dispatches in three separate messages. Expected: parallel-guard advisory on the second sequential pgroup-tagged Agent call.

### REAL-GRD-010 — Panel-guard catches hallucinated personas (v3.1+)
After running a panel that uses fallback personas (e.g., the empty-resource-index path), check `~/.claude/.prism-routing.jsonl` for `panel_hallucination_detected` events. Or run a panel with index empty:
```
plan a hybrid cloud strategy for our infrastructure
```
Expected: panel-guard scans output; if names like "Rachel" or "Priya" appear, flagged as unindexed personas.

---

## Section 3 — Panel composition (5 prompts)

### REAL-PNL-001 — Empty-index warning fires
With `roster.json` blocks empty (fresh install), prompt:
```
plan a migration from MySQL to PostgreSQL with zero downtime
```
Expected: blueprint-prompt activates, panel output includes "Resource-index not populated — hallucination risk HIGH" notice.

### REAL-PNL-002 — Populated-index uses real specialists
Run `/prism-index` first, then re-run REAL-PNL-001. Expected: indexed specialists picked over hardcoded personas; fallback personas (if any) clearly labeled.

### REAL-PNL-003 — Adversarial review (≥2 challenges per position)
```
analyze the trade-offs between REST and GraphQL for our public API
```
Expected: blueprint-prompt full workshop. Each expert position has ≥2 substantive challenges (specific failure mode + scenario + consequence). DROPPED experts visible.

### REAL-PNL-004 — Execution-heavy hand-off
```
implement a feature-flag system across 4 services with admin UI, audit log, and tests
```
Expected: blueprint alignment-pass only (1 primary + 1 risk voice), explicit hand-off to `@master-orchestrator`.

### REAL-PNL-005 — Skeptic role on NOVEL panels
On a NOVEL panel (REAL-PNL-001 or similar), confirm the panel includes a Skeptic archetype that explicitly challenges emerging consensus, not just piles on.

---

## Section 4 — Parallel dispatch (5 prompts)

### REAL-PAR-001 — pgroup=N annotation in plan
```
/prism-plan
plan an audit of three independent modules: auth, payments, notifications
```
Expected: tasks/todo.md (or inline plan) shows `[pgroup=1]` annotations on the 3 scan steps.

### REAL-PAR-002 — Parallel dispatch as one message
After REAL-PAR-001, ask:
```
execute the plan
```
Expected: ONE assistant message with 3 `Agent()` blocks (not 3 sequential messages). Wall-clock < sum of individual durations.

### REAL-PAR-003 — Sequential pgroup violation (parallel-guard fires)
Submit 2 independent dispatch prompts in 2 separate messages within 60s. Each is pgroup-tagged. Expected: prism-parallel-guard fires advisory on the 2nd dispatch.

### REAL-PAR-004 — Hint emitter
On any prompt that implies independent work, check `~/.claude/.prism-routing.jsonl` for `parallel_opportunity` events.

### REAL-PAR-005 — Force-opus bypasses parallel-guard
Force-prefix prompt with sequential dispatch:
```
!opus-force: dispatch three sequential subagents to scan three directories
```
Expected: parallel-guard does NOT block.

---

## Section 5 — Skill invocation (5 prompts)

### REAL-SKI-001 — UX trigger (skill-trigger-guard)
```
review the UX of this landing page and check WCAG accessibility
```
Expected: skill-trigger-guard advisory IF `ui-ux-pro-max` is installed but not auto-invoked.

### REAL-SKI-002 — Plan keyword auto-triggers blueprint-prompt
```
plan a redesign of our checkout flow
```
Expected: blueprint-prompt activates automatically.

### REAL-SKI-003 — `/panel` triggers prism-chat
```
/panel evaluate whether to adopt tRPC across our services
```
Expected: prism-chat activates.

### REAL-SKI-004 — Domain-specialist dispatch from roster
With your specialists rostered (`competitive-intelligence-specialist`, `demand-forecasting-specialist`, `greek-ecommerce-seo-specialist`):
```
audit Greek SEO on acme-shop.example.com
```
Expected: orchestrator picks `greek-ecommerce-seo-specialist` from roster (NOT a generic SEO persona).

### REAL-SKI-005 — Skill NOT auto-invoked (advisory fires)
Ask something where a specialist exists but Claude might answer generically. Check log for `skill_trigger_advisory` events.

---

## Section 6 — Lifecycle (5 prompts)

### REAL-LIF-001 — Session-start bootstrap (plugin install only)
On a fresh plugin install, first session start should bootstrap reference docs from `${CLAUDE_PLUGIN_ROOT}/skills/prism-plan/references/` to `~/.claude/skills/prism-plan/references/`. Verify:
```bash
ls ~/.claude/skills/prism-plan/references/tools-registry.md
```
Expected: file present after first session-start under plugin install.

### REAL-LIF-002 — Memory-save nudge at turn 15
Submit 15 prompts in a session. On the 15th turn-submit, expect a memory-save nudge in stderr.

### REAL-LIF-003 — Subagent-stop sentinel update
Dispatch a subagent. After it completes, check `~/.claude/.prism-turn-tier-<sid>.json` — `dispatched: true`.

### REAL-LIF-004 — Force-opus migration notice (v2.9.1+)
On a fresh install with `PRISM_MODEL_GUARD=hard` set, first session-start should emit a migration notice once (about hard-mode semantic change). Flag file `~/.claude/.prism-v2.9.1-migration-shown` should be created.

### REAL-LIF-005 — Stop hook persists session metrics
End the session (close Claude Code or `/exit`). Stop hook fires. Check `~/.claude/.prism-routing.jsonl` for any session-end events.

---

## After running all sections

1. Note the END time. Compare with start.
2. Run synthetic audit: `bash tests/v3/run-audit.sh --output /tmp/prism-audit-run.jsonl`
3. Run analyzer:
   ```
   node tests/v3/analyze-audit.mjs /tmp/prism-audit-run.jsonl ~/.claude/.prism-routing.jsonl > /tmp/audit-report.md
   ```
4. Or use the orchestrator command: `/prism-audit-full` — does steps 2 and 3 plus structures the final report.

## Reporting

Fill in observations per section in a Markdown file:

```markdown
# PRISM v3.6.0 audit — real-session run

Run start: <ISO>
Run end: <ISO>
Total wall-time: <minutes>

## Section 1 — Classifier (10 prompts)
[per-prompt observed tier/summon_panel/source vs expected]

## Section 2 — Guards
[fires observed, denies seen, force-overrides used]

## Section 3 — Panels
[panel composition, adversarial-review challenge counts, fallback labels]

## Section 4 — Parallel
[message structure observed — 1 msg with N Agent() blocks vs N msgs]

## Section 5 — Skill triggers
[advisories that fired, skills that auto-activated]

## Section 6 — Lifecycle
[bootstrap, nudges, sentinel state]

## Summary
- Total prompts: 40
- Expected behaviors observed: X / 40
- Anomalies / surprises: <list>
- Next steps: <if any>
```

Combined with the synthetic audit's coverage matrix + timing distribution + analyzer report, this gives a comprehensive picture of how PRISM behaves in your specific environment.
