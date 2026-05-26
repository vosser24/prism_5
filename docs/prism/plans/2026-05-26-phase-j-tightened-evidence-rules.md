# Phase J — Tightened evidence rules Implementation Plan (v4.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tighten the PHASE 1.5 senior-review evidence rules in `skills/master-orchestrator/SKILL.md` so un-cited specialist claims get bounced back aggressively per [[D004-v4-product-vision]] §J, while preserving the ≥2 challenge floor on PHASE 0d adversarial review (D004 §7 — no challenge-count bump in v4.0). Concretely: introduce an evidence taxonomy that names what counts as proof per claim class, add a per-claim verdict structure (`EVIDENCED / UN-CITED / REJECTED`) that mirrors PHASE 0d's `ACCEPT / REJECT / CONDITIONAL` shape, replace the soft prose delegation boilerplate with a structured evidence-requirements block specialists see verbatim in their Agent() prompt, and make rejected claims a mandatory line in the user-visible "Senior Review" output instead of letting them silently ship.

**Architecture:** Pure prose change inside the existing PHASE 1.5 section of the master-orchestrator skill body, plus a small drift-guard test mirroring the Phase E thin-wrapper test pattern.

- `skills/master-orchestrator/SKILL.md` PHASE 1.5 section (~lines 434-538) gains three new subsection headings (`### Evidence taxonomy`, `### Per-claim verdict`, restructured `### Standard of evidence — delegation boilerplate`) and an additional bullet in the existing `### Visible output` subsection. No other section is touched. Five Unbreakable Rules (line 36-41) stay verbatim — including rule 4's "at least two substantive challenges" wording — because D004 §7 explicitly defers any challenge-count bump to v4.1.
- A new `tests/v3/state/test-master-orchestrator-evidence-rules.mjs` test asserts the new heading strings and verdict tokens (`EVIDENCED`, `UN-CITED`, `REJECTED`) remain present in the skill body. This is a content drift-guard, not a behavioral test — skills are prose the LLM reads, so a grep-level assertion is the right altitude. The test runs in the same suite as `test-master-orchestrator-thin-wrapper.mjs` and follows its scaffolding verbatim.
- `agents/master-orchestrator.md` is NOT touched: the body is already the canonical `Load skill: master-orchestrator\n` one-liner, and skill changes propagate through that wrapper automatically.

**Tech Stack:** Node 18+ ES modules, no new deps. Same `readFileSync` + assertion pattern as the existing thin-wrapper test. No package.json; runner is `node tests/v3/state/test-master-orchestrator-evidence-rules.mjs`.

**Locked design references:**
- `docs/prism/adjudications/D004-v4-product-vision.md` Phase J row of the v4.0 phase plan table — *"Tightened evidence rules — PHASE 1.5 senior review rejects un-cited claims more aggressively; no challenge-count bump."*
- `docs/prism/adjudications/D004-v4-product-vision.md` §7 — "Adversarial floor stays at ≥2 (v2.7.0 baseline). PHASE 0d adversarial review keeps 'at least two substantive challenges' for NOVEL-tier work. Bump to ≥3 deferred to v4.1 pending telemetry."
- `docs/prism/adjudications/D004-v4-product-vision.md` risk-register #6 — "master-orchestrator skill vs agent file divergence → Agent file body = `Load skill: master-orchestrator` one-liner only; CI assert keeps them in sync." Phase J does NOT modify the agent body, so this risk is unchanged.
- `skills/master-orchestrator/SKILL.md` lines 36-41 — Five Unbreakable Rules block. Rule 4 (≥2 challenges) and rule 5 (PHASE 1.5 on FULL-NOVEL / HIGH-STAKES) are the spec contracts Phase J must preserve.
- `skills/master-orchestrator/SKILL.md` lines 216-267 — PHASE 0d adversarial review section. Phase J mirrors its `ACCEPT / REJECT / CONDITIONAL` verdict shape and "two FLOOR not target" language so the new evidence verdict reads as a sibling protocol, not a parallel ad-hoc one.
- `skills/master-orchestrator/SKILL.md` lines 434-538 — current PHASE 1.5 section. The "Standard of evidence" subsection (~lines 493-504) is the principal target; "Visible output" (~lines 527-538) gains one mandatory bullet.
- `tests/v3/state/test-master-orchestrator-thin-wrapper.mjs` — existing drift-guard test pattern. The new Phase J test re-uses this file's scaffolding (`assert`, `assertEq`, `test`, `parseBody` if needed) verbatim and lives as a sibling in the same directory.
- `docs/prism/plans/2026-05-25-phase-e-master-orchestrator-skill.md` — precedent for "skill body changes via drift-guard test only, no behavioral test" (Phase E added the thin-wrapper test; Phase J adds the evidence-rules sibling).
- `docs/prism/lessons/2026-05-25-dev-install-inventory.md` — re-sync pattern; one inventory row per phase that touches user-installed files.

**Out of scope (deferred):**
- Any change to PHASE 0d adversarial review challenge count or shape (D004 §7 defers to v4.1 with telemetry).
- A behavioral test that runs a synthetic panel through the new rules and asserts rejection fires. Skills are prose for the LLM to read; a behavioral test would require harnessing a fake panel, which is unjustified for a 0.3d phase. Manual dog-food in Task 4 covers this.
- A user-level rejection-rate telemetry counter (would belong in `~/.claude/.prism-routing.jsonl` rollup). Defer to v4.1 when telemetry surfaces are reviewed system-wide.
- Auto-fire factory upgrade on N consecutive UN-CITED verdicts. The skill prose makes the recommendation visible, but the wire-up to `roster.json` `pending_upgrade: true` is an existing PHASE 2c surface — Phase J just reuses it; no new code path.
- Phase K (release prep) — separate plan once Phase J + manual dog-food land.

**File structure:**

| File | Action | Responsibility |
|---|---|---|
| `tests/v3/state/test-master-orchestrator-evidence-rules.mjs` | **CREATE** | Reads `skills/master-orchestrator/SKILL.md`, asserts presence of the new heading strings and verdict tokens. Mirrors the thin-wrapper test scaffolding. Runs via `node tests/v3/state/test-master-orchestrator-evidence-rules.mjs`. |
| `skills/master-orchestrator/SKILL.md` | **MODIFY** | PHASE 1.5 section gets `### Evidence taxonomy`, `### Per-claim verdict`, restructured `### Standard of evidence — delegation boilerplate`. `### Visible output` gains one new mandatory bullet. Five Unbreakable Rules and PHASE 0d untouched. |
| `docs/prism/lessons/2026-05-25-dev-install-inventory.md` | **MODIFY** | Add a single Phase J row noting that `skills/master-orchestrator/SKILL.md` re-sync is required; no new bulk entries needed (the existing row already covers the file). |

---

### Task 1: Write the failing drift-guard test (TDD red)

**Why first:** TDD discipline. The test pins the new heading strings and verdict tokens so the prose change in Task 2 can't accidentally drift away from them, and a future contributor can't silently trim the new structure back out without the suite catching it.

**Files:**
- Create: `tests/v3/state/test-master-orchestrator-evidence-rules.mjs`

- [ ] **Step 1: Confirm the sibling test pattern**

```bash
ls tests/v3/state/test-master-orchestrator-*.mjs
wc -l tests/v3/state/test-master-orchestrator-thin-wrapper.mjs
```

Expected: exactly one file (`test-master-orchestrator-thin-wrapper.mjs`, ~76 lines). The new Phase J test joins it.

- [ ] **Step 2: Write the new test file**

Create `tests/v3/state/test-master-orchestrator-evidence-rules.mjs` with this exact content:

```javascript
#!/usr/bin/env node
// CI drift-guard for D004 §J (Phase J — tightened evidence rules):
//   "PHASE 1.5 senior review rejects un-cited claims more aggressively;
//    no challenge-count bump."
//
// Reads skills/master-orchestrator/SKILL.md and asserts that PHASE 1.5
// retains the structured evidence rules introduced in Phase J:
//   - ### Evidence taxonomy heading
//   - ### Per-claim verdict heading
//   - EVIDENCED / UN-CITED / REJECTED verdict tokens
//   - "bounce back ONCE" + "KNOWN LIMITATION" escalation phrases
//   - "Claims rejected" bullet in the Visible output subsection
//
// Also asserts the negative — D004 §7 invariants the phase MUST preserve:
//   - Five Unbreakable Rules block still present
//   - PHASE 0d still says "at least two substantive challenges"
//   - No challenge-count bump to "three" / "≥3" in PHASE 0d
//
// Failure = someone trimmed the Phase J structure back out, OR bumped
// the PHASE 0d challenge floor without a follow-up D### adjudication.
//
// Run: node tests/v3/state/test-master-orchestrator-evidence-rules.mjs

import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_FILE = join(__dirname, '..', '..', '..', 'skills', 'master-orchestrator', 'SKILL.md');

let pass = 0, fail = 0;

function test(name, fn) {
  try { fn(); pass++; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { fail++; process.stdout.write(`  FAIL ${name}\n        ${e.stack || e.message}\n`); }
}

function assert(cond, msg) { if (!cond) throw new Error('assert: ' + (msg || '')); }

const raw = readFileSync(SKILL_FILE, 'utf8').replace(/\r\n/g, '\n');

// ─────────────────────────────────────────────────────────────────────────
// Positive assertions: Phase J structure must be present
// ─────────────────────────────────────────────────────────────────────────

test('PHASE 1.5 introduces an "Evidence taxonomy" subsection heading', () => {
  assert(/^### Evidence taxonomy\b/m.test(raw),
         'expected "### Evidence taxonomy" heading inside PHASE 1.5');
});

test('PHASE 1.5 introduces a "Per-claim verdict" subsection heading', () => {
  assert(/^### Per-claim verdict\b/m.test(raw),
         'expected "### Per-claim verdict" heading inside PHASE 1.5');
});

test('PHASE 1.5 defines the three verdict tokens EVIDENCED / UN-CITED / REJECTED', () => {
  assert(/\bEVIDENCED\b/.test(raw), 'EVIDENCED token missing');
  assert(/\bUN-CITED\b/.test(raw), 'UN-CITED token missing');
  assert(/\bREJECTED\b/.test(raw), 'REJECTED token missing');
});

test('PHASE 1.5 escalation rule: bounce ONCE then ship as KNOWN LIMITATION', () => {
  // Pin uppercase ONCE and KNOWN LIMITATION — these are deliberate verdict-style
  // tokens introduced by Phase J. The pre-Phase-J prose uses lowercase ("bounced
  // back once", "Known limitations remaining"), so case-sensitive matching here
  // gives the TDD-red state Task 2 must satisfy.
  assert(/[Bb]ounce[^.\n]{1,60}\bONCE\b/.test(raw),
         'expected "Bounce ... ONCE" (uppercase ONCE token) rule in PHASE 1.5');
  assert(/KNOWN LIMITATION/.test(raw),
         'expected "KNOWN LIMITATION" (uppercase singular token) in PHASE 1.5');
  // Also pin the normative bullet in ### Per-claim verdict — the bold "**Bounce
  // back ONCE**" phrase may wrap across lines, so use \s+ here rather than the
  // single-line [^.\n] used above. A targeted lowercase revert of just that
  // bullet would otherwise slip past the single-line assertion.
  assert(/\*\*Bounce\s+back ONCE\*\*/.test(raw),
         'expected "**Bounce back ONCE**" (bold uppercase token) in Per-claim verdict bullet');
});

test('Visible output requires a rejected-claims line in the user-facing Senior Review', () => {
  // The bullet must mention rejected claims so the user sees the bounce outcome
  // rather than getting a clean-but-opaque summary.
  assert(/Claims rejected|rejected (?:as |claims)/i.test(raw),
         'expected a "Claims rejected" bullet in PHASE 1.5 Visible output');
});

test('Delegation boilerplate names the taxonomy classes specialists must satisfy', () => {
  // The specialist-facing block must enumerate the categories so the bounce
  // criteria are visible at delegation time, not just at review time.
  const categories = ['performance', 'security', 'correctness', 'completeness', 'compatibility'];
  for (const cat of categories) {
    assert(new RegExp(`\\b${cat}\\b`, 'i').test(raw),
           `delegation boilerplate must name claim category "${cat}"`);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Negative assertions: D004 §7 invariants Phase J MUST preserve
// ─────────────────────────────────────────────────────────────────────────

test('Five Unbreakable Rules block is preserved verbatim (rule 4 + rule 5 anchors)', () => {
  assert(/Five unbreakable rules:/i.test(raw),
         'Five Unbreakable Rules header missing');
  assert(/at least two substantive challenges/.test(raw),
         'rule 4 "at least two substantive challenges" wording missing — challenge floor MUST stay at ≥2 per D004 §7');
  assert(/PHASE 1\.5 senior review on FULL-NOVEL and HIGH-STAKES/.test(raw),
         'rule 5 PHASE 1.5 anchor missing');
});

test('PHASE 0d still requires "at least two substantive challenges" (no bump to ≥3)', () => {
  // Match the PHASE 0d sentence specifically — the floor phrase appears in
  // multiple places (rule 4 + PHASE 0d body); both must read "two", not "three".
  const phase0dBlock = (raw.split(/^### PHASE 0d:/m)[1] || '').split(/^###/m)[0];
  assert(phase0dBlock.length > 0, 'PHASE 0d section missing entirely');
  assert(/at least two substantive challenges/.test(phase0dBlock),
         'PHASE 0d floor phrase must remain "two" — D004 §7 defers ≥3 to v4.1');
  assert(!/at least three substantive challenges|≥\s*3 substantive challenges/i.test(phase0dBlock),
         'PHASE 0d MUST NOT bump to three challenges — D004 §7 requires telemetry first');
});

test('Phase J does not leak into the thin-wrapper agent file', () => {
  // Re-assert the thin-wrapper invariant locally so a Phase J reviewer doesn't
  // need to also run the thin-wrapper test to confirm the boundary held.
  const agentFile = join(__dirname, '..', '..', '..', 'agents', 'master-orchestrator.md');
  const agent = readFileSync(agentFile, 'utf8');
  assert(!/Evidence taxonomy|Per-claim verdict|EVIDENCED|UN-CITED/.test(agent),
         'Phase J prose leaked into agents/master-orchestrator.md — must live only in the skill body');
});

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 3: Run the new test — verify it FAILS**

```bash
node tests/v3/state/test-master-orchestrator-evidence-rules.mjs
```

Expected:
- The 6 positive-assertion tests FAIL (skill body doesn't have the new structure yet).
- The 3 negative-assertion tests PASS (the invariants Phase J must preserve are still in place from Phase E).

Specifically: `FAIL` lines for "Evidence taxonomy", "Per-claim verdict", verdict tokens, bounce-ONCE rule, Visible-output bullet, and delegation taxonomy. `ok` lines for the Five Unbreakable Rules, PHASE 0d floor, and no-leakage assertions.

- [ ] **Step 4: Confirm the rest of the suite is unaffected**

```bash
node tests/v3/state/test-master-orchestrator-thin-wrapper.mjs
```

Expected: still 3 passed, 0 failed. The Phase J test is additive; it does not modify the agent file or any other tested surface.

- [ ] **Step 5: Commit the failing test**

```bash
git add tests/v3/state/test-master-orchestrator-evidence-rules.mjs
git commit -m "$(cat <<'EOF'
test(prism): add Phase J drift-guard for tightened evidence rules (TDD red)

Adds tests/v3/state/test-master-orchestrator-evidence-rules.mjs which
asserts the structure D004 §J locks in for PHASE 1.5 senior review:
"Evidence taxonomy" + "Per-claim verdict" subsection headings,
EVIDENCED / UN-CITED / REJECTED verdict tokens, the bounce-ONCE
escalation rule, the Visible-output rejected-claims bullet, and the
delegation-boilerplate taxonomy class names. Also negative-asserts
the D004 §7 invariants the phase must preserve: Five Unbreakable
Rules verbatim, PHASE 0d floor still ≥2 challenges (no v4.1-deferred
bump to ≥3), no Phase J prose leakage into the thin-wrapper agent file.

Six positive assertions currently FAIL; Task 2 introduces the skill
body structure that makes them green.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Update PHASE 1.5 in `skills/master-orchestrator/SKILL.md` (TDD green)

**Why now:** Tests are failing. This step adds the structured evidence rules that make them pass without touching any other section of the skill.

**Files:**
- Modify: `skills/master-orchestrator/SKILL.md` (PHASE 1.5 section only)

- [ ] **Step 1: Locate the existing "Standard of evidence" subsection**

```bash
grep -n "^### Standard of evidence\|^### Factory escalation\|^### Visible output\|^## PHASE 2" skills/master-orchestrator/SKILL.md
```

Expected output:
```
494:### Standard of evidence (enforced at delegation, verified at review)
507:### Factory escalation from senior review
527:### Visible output
540:## PHASE 2: COMPLETION
```

(Line numbers may shift by ±1 depending on prior commits — the headings are what matter.)

The "Standard of evidence" subsection (line 494 to just before line 507) is the principal replacement target. The "Visible output" subsection (line 527 to just before line 540) gets a one-line addition.

- [ ] **Step 2: Replace the "Standard of evidence" subsection with three new subsections**

Open `skills/master-orchestrator/SKILL.md`. Find and remove the entire current "Standard of evidence (enforced at delegation, verified at review)" subsection — from the heading line down to (but not including) the next `### Factory escalation from senior review` heading.

Insert the following three subsections in its place (heading order: taxonomy → verdict → delegation boilerplate, so the reader sees the *what counts* before the *what to do about it*):

```markdown
### Evidence taxonomy

Every non-trivial claim a specialist returns belongs to a class. Each class
has a fixed bar for what counts as evidence. If the bar is not met, the
claim is **un-cited** and triggers the per-claim verdict below — there is
no rhetorical wiggle room here.

| Claim class | What counts as evidence |
|---|---|
| **Performance** (`X is fast`, `scales to Y`, `cheap`) | Benchmark numbers with environment + N (runs), OR a comparison against a named baseline measurement. Adjectives alone never qualify. |
| **Security** (`X is secure`, `resists Y`, `safe by default`) | An explicit threat model statement + at least one probe/test attempted, OR a named OWASP / CWE category with the mitigation cited. |
| **Correctness** (`X works`, `handles edge cases`, `is sound`) | A passing test cited by path + test name, OR an enumerated edge-case list (≥3 items) with the disposition of each. |
| **Completeness** (`covers all cases`, `no gaps`, `exhaustive`) | The enumeration above, OR an explicit "known limitations" subsection naming what is NOT covered. |
| **Compatibility** (`works on X version`, `cross-platform`) | A version-stamped test, OR a quote from the source's compatibility docs (URL or repo-relative path). |
| **External tool / library claims** | Citation of the source URL or doc path with the version pinned. |

A non-trivial claim that doesn't fit a class above defaults to the
**Correctness** row: name the test or enumerate the cases. "Trivial"
means restating a fact already established elsewhere in the panel
output, or describing what the specialist literally did (`I read the
file`) — not opinions about the result.

### Per-claim verdict

For each non-trivial claim a specialist returns, YOU issue exactly one
verdict. This mirrors PHASE 0d's `ACCEPT / REJECT / CONDITIONAL` shape
deliberately — the evidence layer is a peer protocol to the challenge
layer, not an ad-hoc afterthought.

- **EVIDENCED** — Evidence cited matches the taxonomy row for the claim's
  class. Claim survives into the final plan.
- **UN-CITED** — Claim is non-trivial but no evidence is offered. **Bounce
  back ONCE** with the specific taxonomy row that applies and the exact
  evidence the specialist must produce. If the second pass still lacks
  evidence, **ship the claim as a KNOWN LIMITATION** in the Visible output
  rather than letting it sneak into the deliverable. Do not bounce a
  third time.
- **REJECTED** — Evidence was offered but does not support the claim
  (e.g., a benchmark on a different workload, a threat model that
  ignores the relevant threat, an enumerated list missing the
  edge case the user actually asked about). Same bounce-ONCE protocol
  as UN-CITED; same KNOWN-LIMITATION fallback on the second miss.

> **Token note:** `REJECTED` here is a PHASE 1.5 orchestrator verdict on
> a claim's evidence quality. It is distinct from `REJECT` (no -ED),
> which is the PHASE 0d expert response to a challenge. The peer-protocol
> framing above is intentional; the -ED suffix is load-bearing
> disambiguation when both verdict layers appear in the same plan output.

**Aggressive rejection — this is the Phase J intent:** if a specialist's
output reads as confident and conclusion-heavy with no cited proof, do
NOT charitably interpret it. Issue UN-CITED verdicts on the load-bearing
claims and bounce. The specialist's job is to produce evidenced
deliverables; yours is to refuse to launder un-cited assertion into the
final plan.

**Factory-upgrade trigger:** if a single PHASE 1.5 pass produces **≥3
UN-CITED verdicts on the same specialist**, set
`pending_upgrade: true` on their `roster.json` entry immediately and
surface it in the final user report. Domain confidence is suspect when
a specialist cannot cite three claims in their stated expertise — this
is the same threshold as the PHASE 2c `corrections_since_last_upgrade
≥ 3` rule, applied at the evidence layer.

This is a SEPARATE trigger from the domain-gap escalation in
`### Factory escalation from senior review` below. That section fires
on `2+ misses` of domain expertise (gaps a specialist SHOULD have
caught in their stated domain); this trigger fires on `≥3 UN-CITED
verdicts` (claims a specialist MADE without evidence). Both flip
`pending_upgrade: true`, but the diagnoses are different — a specialist
with many uncited claims has evidence-discipline issues, while one
with recurring domain gaps has knowledge-coverage issues. Either path
is sufficient on its own; neither blocks the other.

### Standard of evidence — delegation boilerplate

When you spawn a specialist via `Agent()`, include this structured block
verbatim in the prompt. The taxonomy must be visible to the specialist
at delegation time, not just at review time — otherwise the bounce-ONCE
loop just adds latency for evidence the specialist could have included
on pass #1.

> **EVIDENCE REQUIREMENTS (PHASE 1.5 enforcement, v4.0 Phase J):**
>
> Each non-trivial claim in your output MUST carry evidence per the
> taxonomy:
>
> - **performance** → benchmark numbers (with environment + N) OR
>   comparison against a named baseline
> - **security** → threat model statement + probe attempted, OR a named
>   OWASP / CWE category with mitigation cited
> - **correctness / completeness** → cited test (path + name) OR an
>   enumerated edge-case list (≥3 items) with disposition of each
> - **compatibility** → version-stamped test OR quote from compat docs
>   (URL or repo path)
> - **external tool / library** → source URL or doc path, version pinned
>
> The orchestrator will issue per-claim verdicts in senior review.
> Un-cited or unsupported claims are bounced back ONCE with the specific
> taxonomy row that applies. A second pass without evidence does NOT
> ship as a deliverable — it ships as a KNOWN LIMITATION in the user-
> facing Senior Review section, attributed to your output. Recurring
> un-cited verdicts (≥3 in one pass) trigger an upgrade recommendation
> on your roster entry.
>
> An assertion without evidence is a draft, not a deliverable.

Then in PHASE 1.5, actually follow through. The bounce-ONCE rule is a
contract with the user, not a soft suggestion: a specialist who returns
"this handles all the edge cases" with no enumerated edge cases gets
the work bounced back ONCE, and if pass #2 still lacks evidence, the
claim ships as a KNOWN LIMITATION rather than as a clean assertion. Do
not silently accept the second pass to spare the specialist or move
faster. The user gets more value from a plan that says "we couldn't
verify edge-case coverage" than from one that claims coverage without
proof.
```

- [ ] **Step 3: Update the "Visible output" subsection**

Find the existing `### Visible output` subsection (~line 527). It currently lists four bullets:

```markdown
- Claims that survived review and the evidence for each
- Claims you revised during review and why
- Gaps you caught and how they were closed (delegated back / owned)
- Known limitations remaining and why they weren't closed
```

Insert a new second bullet so the list reads:

```markdown
- Claims that survived review (EVIDENCED) and the evidence cited for each
- **Claims rejected as UN-CITED or REJECTED, and the outcome on the second
  pass — corrected (now EVIDENCED), escalated to user, or shipped as
  KNOWN LIMITATION**
- Claims you revised during review and why
- Gaps you caught and how they were closed (delegated back / owned)
- Known limitations remaining (including those shipped from bounced
  claims above) and why they weren't closed
```

Also append one line at the end of the subsection (after the existing "Do not summarize the review away..." paragraph):

```markdown
The rejected-claims bullet is mandatory whenever a bounce occurred — even
if every bounce eventually returned EVIDENCED. The user must see which
claims were stress-tested at the evidence layer, not just which ones
survived.
```

- [ ] **Step 4: Confirm the Five Unbreakable Rules block is unchanged**

```bash
grep -n "at least two substantive challenges" skills/master-orchestrator/SKILL.md
```

Expected: exactly two matches — one in rule 4 of the Five Unbreakable Rules block, one in the PHASE 0d section. Both must read "two", not "three". If either was edited, revert.

```bash
grep -n "Five unbreakable rules:" skills/master-orchestrator/SKILL.md
```

Expected: one match (the rules header). The rules block is untouched.

- [ ] **Step 5: Run the new test — verify all green**

```bash
node tests/v3/state/test-master-orchestrator-evidence-rules.mjs
```

Expected: all 9 tests pass (6 positive + 3 negative). Zero failures.

- [ ] **Step 6: Run the FULL test suite — confirm zero regressions**

```bash
node tests/v3/state/test-prism-state.mjs
node tests/v3/state/test-prism-bootstrap.mjs
node tests/v3/state/test-prism-deep-dive.mjs
node tests/v3/state/test-prism-sync.mjs
node tests/v3/state/test-prism-clean.mjs
node tests/v3/state/test-prism-validate-plugins.mjs
node tests/v3/state/test-master-orchestrator-thin-wrapper.mjs
node tests/v3/state/test-master-orchestrator-evidence-rules.mjs
node tests/v3/hooks/test-agent-write-register.mjs
```

Expected: all 9 suites green. Phase H baseline (147) + 9 new (Phase J) = 156.

- [ ] **Step 7: Commit**

```bash
git add skills/master-orchestrator/SKILL.md
git commit -m "$(cat <<'EOF'
feat(prism): tighten PHASE 1.5 evidence rules (Phase J — D004 §J)

Adds three new subsections inside PHASE 1.5 of the master-orchestrator
skill: an Evidence taxonomy table (six claim classes → required evidence),
a Per-claim verdict structure (EVIDENCED / UN-CITED / REJECTED) that
mirrors PHASE 0d's ACCEPT / REJECT / CONDITIONAL shape, and a structured
delegation boilerplate the orchestrator pastes verbatim into Agent()
prompts so specialists see the bar at delegation time.

Bounce protocol is now explicit: ONCE per un-cited or rejected claim,
and a second-pass miss ships as KNOWN LIMITATION in the user-facing
Senior Review output rather than as a clean assertion. Recurring
un-cited verdicts (≥3 in one pass) flip pending_upgrade on the
specialist's roster entry — same threshold as the existing PHASE 2c
correction counter.

Visible output gains a mandatory "Claims bounced" bullet so the user
sees which claims were stress-tested at the evidence layer.

Per D004 §7, the PHASE 0d adversarial-review floor stays at ≥2
challenges — no challenge-count bump in v4.0. The Five Unbreakable
Rules block is unchanged. Agent thin-wrapper is unchanged (Phase J
prose lives only in the skill body).

Closes Phase J of the v4.0 phase plan.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Re-sync dev install + update inventory

**Why now:** The branch is local-only, so user-level installs at `~/.claude/skills/master-orchestrator/SKILL.md` don't pick up the Phase J prose until we hand-sync. The dev-install inventory already covers `skills/master-orchestrator/SKILL.md` under the Phase E row, so no new bulk entries are needed — but a re-sync IS required, and the inventory deserves a Phase J row so the next reader knows which phase last touched the file.

**Files:**
- Sync: `skills/master-orchestrator/SKILL.md` → `~/.claude/skills/master-orchestrator/SKILL.md`
- Modify: `docs/prism/lessons/2026-05-25-dev-install-inventory.md`

- [ ] **Step 1: Copy the updated skill file**

```bash
cp Y:/Documents/utilities_projects/prism_3/skills/master-orchestrator/SKILL.md "$HOME/.claude/skills/master-orchestrator/SKILL.md"
```

- [ ] **Step 2: Verify the sync**

```bash
grep -c "Evidence taxonomy\|Per-claim verdict\|EVIDENCED" "$HOME/.claude/skills/master-orchestrator/SKILL.md"
```

Expected: a non-zero count (3 or more matches across the three patterns). If 0, the sync didn't land — re-run Step 1 and re-check the destination path.

- [ ] **Step 3: Append a Phase J note to the dev-install inventory**

Open `docs/prism/lessons/2026-05-25-dev-install-inventory.md`. The existing Phase E + Phase H rows already cover `skills/master-orchestrator/SKILL.md`. Add one final row to the table for clarity:

```markdown
| `skills/master-orchestrator/SKILL.md` (Phase J — tightened evidence rules in PHASE 1.5) | (already covered by Phase E row above; re-sync required) | **Phase J** |
```

The cleanup PowerShell block needs no update — `Remove-Item -Recurse -Force ... skills/master-orchestrator` already wipes the directory.

- [ ] **Step 4: Commit the inventory update**

```bash
git add docs/prism/lessons/2026-05-25-dev-install-inventory.md
git commit -m "$(cat <<'EOF'
docs(prism): note Phase J re-sync in dev-install inventory

Phase J modifies skills/master-orchestrator/SKILL.md, which is already
covered by the Phase E + Phase H bulk rows. Adds a single row marking
the Phase that last touched the file so future readers can locate the
relevant adjudication (D004 §J).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Manual dog-food verification (USER-DRIVEN)

**Why last:** The new evidence rules govern LLM-judged orchestration; a deterministic test can pin the structure but cannot verify that the orchestrator actually applies the verdicts under realistic pressure. Only a real session with a real (or synthetic) panel can validate that.

**This task is user-driven.** Implementer marks Tasks 1-3 complete and hands these steps off.

- [ ] **Step 1: Stage a synthetic FULL-NOVEL panel that produces un-cited claims**

In any project that has a `master-<slug>` agent (the `competition_agents/` testbed from Phase D works fine), open a Claude Code session and trigger a FULL-NOVEL-tier task that requires hiring at least one specialist. For example:

> "Design a caching layer for the report API. Performance and security are both load-bearing."

The orchestrator will assemble a panel. Watch for specialists who produce claims like:

- *"This handles all the edge cases."* (correctness — un-cited unless edge cases are enumerated)
- *"This is faster than the current implementation."* (performance — un-cited unless benchmark numbers cited)
- *"Standard cache invalidation, secure by default."* (security — un-cited unless threat model named)

These are the exact patterns Phase J targets.

- [ ] **Step 2: Observe the PHASE 1.5 senior-review output**

The orchestrator should now:

1. Issue an explicit `UN-CITED` or `REJECTED` verdict for each un-cited claim — visible in the chat output.
2. Bounce each claim back ONCE with the specific taxonomy row that applies.
3. If pass #2 returns evidence: re-classify as `EVIDENCED`, claim ships clean.
4. If pass #2 still lacks evidence: ship the claim as a `KNOWN LIMITATION` in the final Senior Review section, not as a clean assertion.

If ANY of those four behaviors is missing — e.g., the orchestrator silently accepts un-cited claims, bounces twice instead of once, or buries rejected claims in a summary rather than the user-facing output — that is a Phase J regression. Report exactly what was observed.

- [ ] **Step 3: Check the visible "Senior Review" output**

The final plan should contain a "Senior Review" section with:

- A list of `EVIDENCED` claims and the evidence cited for each.
- A list of claims that were bounced (`UN-CITED` or `REJECTED`) and the outcome on the second pass.
- (If applicable) `KNOWN LIMITATION` entries for claims that shipped without evidence after the bounce.
- Gaps you caught and how they were closed.

If the "Claims bounced" subsection is absent and no bounces occurred during the session, that's fine — the section is mandatory only when a bounce actually happened. If a bounce DID occur and the section is missing, that's a Phase J regression.

- [ ] **Step 4: Optional — verify the factory-upgrade trigger**

If you can engineer a specialist to produce ≥3 un-cited claims in a single PHASE 1.5 pass (e.g., by giving them a vague spec with multiple load-bearing aspects), check the final user report for a `pending_upgrade: true` recommendation on that specialist. Then verify `roster.json` actually has the flag set:

```bash
grep -A 3 "<specialist-name>" "$HOME/.claude/skills/prism-plan/references/roster.json"
```

Expected: `"pending_upgrade": true` and a `"status"` mention of the un-cited misses.

- [ ] **Step 5: Verify PHASE 0d still uses ≥2 challenges (regression check)**

Same session — look at the PHASE 0d adversarial-review block in the plan output. Each surviving expert should have **exactly two or more** challenges levied against their position, NOT three. If three or more challenges appear and there's no explicit "I'm going deeper here because the position looks glib" justification, that's a regression against D004 §7 (the floor must stay at ≥2 until v4.1 telemetry justifies a bump).

- [ ] **Step 6: Report back to the controller**

If Steps 1-3 (and optionally 4-5) all pass, report green. The controller will:

1. Commit an empty milestone marker: `test(prism): Phase J tightened evidence rules verified end-to-end`.
2. Mark the Phase J plan complete.
3. Offer to start Phase K (release prep) — separate plan via writing-plans.

If any step fails, report exactly what went wrong (which step, which specialist, what the un-cited claim was, what the orchestrator did or did not do) so the controller can triage before declaring Phase J done.

---

## Self-review (writing-plans checklist)

**1. Spec coverage:**

| D004 §J / §7 requirement | Plan task |
|---|---|
| PHASE 1.5 rejects un-cited claims more aggressively | Task 1 (test asserts verdict structure + bounce-ONCE rule) + Task 2 (skill body adds Evidence taxonomy + Per-claim verdict + delegation boilerplate) |
| Bounce ONCE then ship as KNOWN LIMITATION (vs silently accepting) | Task 1 bounce-ONCE assertion + Task 2 "Aggressive rejection" paragraph and Visible-output rejected-claims bullet |
| Visible output makes rejected claims load-bearing | Task 1 Visible-output assertion + Task 2 Step 3 new bullet + mandatory-when-bounce-occurred paragraph |
| No challenge-count bump on PHASE 0d (≥2 stays) | Task 1 negative assertions on Five Unbreakable Rules + PHASE 0d body + Task 2 Step 4 grep check |
| Factory-upgrade recommendation on recurring un-cited verdicts | Task 2 "Factory-upgrade trigger" paragraph reuses existing PHASE 2c `pending_upgrade` surface |
| Per-quarter auto re-synth / telemetry rollups | EXPLICITLY DEFERRED (Out of scope section — v4.1) |

All 5 in-scope §J requirements have an assigned task; v4.1 deferrals are explicit. ✓

**2. Placeholder scan:** No TBDs, no "implement later", no "similar to Task N". Each prose insertion is shown in full. Each test assertion is shown in full. Each commit message is shown in full. The only flexibility is in Task 2 Step 1 where line numbers are approximate (`±1` noted explicitly) because prior commits could have shifted them — the headings are what matter and they're spelled out. ✓

**3. Type consistency:** Verdict tokens (`EVIDENCED` / `UN-CITED` / `REJECTED`) match VERBATIM across Task 1 test assertions, Task 2 prose, Task 2 commit message, and Task 4 dog-food expectations. Heading strings (`### Evidence taxonomy`, `### Per-claim verdict`, `### Standard of evidence — delegation boilerplate`, `### Visible output`) match across the same surfaces. Taxonomy class names (`performance`, `security`, `correctness`, `completeness`, `compatibility`, `external tool / library`) match between Task 1 delegation-boilerplate assertion (lowercase regex), Task 2 prose table (bolded), and Task 2 delegation block (lowercase bolded). Bounce-ONCE language is the same string in Task 1 regex, Task 2 verdict prose, Task 2 boilerplate, and Task 4 dog-food expectations. ✓

---

## Execution Handoff

**Plan complete and saved to `docs/prism/plans/2026-05-26-phase-j-tightened-evidence-rules.md`.** Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task with review between tasks. Fits this plan well because Tasks 1+2 form a tight TDD red/green pair, Task 3 is a docs-only re-sync that benefits from independent review, and Task 4 is user-driven. Three subagent dispatches (Task 1 → review → Task 2 → review → Task 3 → review → Task 4 hand-off).

**2. Inline Execution** — Execute Tasks 1-3 in this session using `superpowers:executing-plans`, with a single checkpoint after Task 2 (the load-bearing prose change has landed; Task 3 is just a sync). Task 4 is always user-driven.

**Which approach?**
