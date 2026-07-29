# Capture conventions

When the session produces durable knowledge, write it under `docs/prism/`
in the right bucket. PRISM `/prism-clean` and the v3.10.0 archival path
expect this layout.

## Buckets

| Folder | What goes there | Example filename |
|--------|-----------------|------------------|
| `adjudications/` | Locked panel decisions, architecture call-outs | `D003-postgres-vs-sqlite.md` |
| `deviations/` | Agent/sub-agent reports of cases the rule did not fit | `2026-05-06-agent-X-deviation.md` |
| `lessons/` | Cross-task tactical lessons (created by `/prism-clean`) | `2026-05-06-session-lessons.md` |
| `smoke/` | Reusable smoke procedures, runbooks | `smoke-postgres-restart.md` |

## File-naming rules

- Adjudications: `D###-<short-slug>.md`, sequential, never re-used.
- Deviations: `YYYY-MM-DD-<agent-name>-deviation.md`.
- Lessons: `YYYY-MM-DD-session.md` (one per /prism-clean run).
- Smoke: `smoke-<topic>.md`.

## The `**Rule:**` header line

New adjudications and lessons SHOULD include a `**Rule:** <imperative>` line immediately after the required header block. Write one concise, actionable sentence capturing the core decision. This line is extracted by `tools/prism-knowledge-index.mjs` and injected verbatim by `hooks/prism-lesson-match.mjs` when the prompt matches — replacing a file-pointer that would require a follow-up read. **Rule:** lines are auto-collected into the `## Standing rules` block on SessionStart by `tools/lib/memory-heal.mjs` (`regenerateStandingRules`), ordered newest-Locked-first and capped — this is the always-on deterministic recall layer in `.claude/agents/MEMORY.md`, and it is genuinely auto-managed (not a manual step someone has to remember to run). If a `**Rule:**` line is absent, the matcher falls back to the title, which is less actionable, and `regenerateStandingRules` has nothing to collect for that file.

## Anti-brevity rule for task carryover (v6.2.0 — recall hardening)

The `description` field on a `TaskCreate`/`TaskUpdate` call is a durable
artifact, not a chat aside: it is the sole record that survives a `/clear` or
session end and is what a resumed session (or a `/prism-clean` handoff) reads
back. Treat it like a captured lesson, not like a live status line:
- Self-contained: restate the acceptance criteria, the target file(s), and
  enough surrounding context that the description alone (no scrollback) is
  enough to resume the work correctly.
- Do NOT compress it to the terse `[tier] action — done when:` one-liner
  style used for the live checklist row shown turn-by-turn — that style is
  acceptable there because the user still has the surrounding conversation;
  it is not acceptable in a `description` field that must outlive the
  conversation.
- When carrying tasks into a `/prism-clean` handoff (Step 4b), copy the
  description **verbatim** — do not re-summarize or further compress it.

## Required headers

Every captured file starts with:

```markdown
# <one-line title>

**Status:** Locked | Proposed | Draft | Superseded | Withdrawn
**Date:** YYYY-MM-DD
**Captured by:** <session id or "manual">
**Related:** (optional links to other adjudications)
**Superseded-by:** (Superseded only) <D### file(s) that replaced this one> — <one-line reason>
**Rule:** <one-line imperative — what to do or not do>
```

## Locking

A file with `Status: Locked` is referenced in `CLAUDE.md` and may not be
edited in place. Subsequent design changes create a new file referencing
the locked one.

## Proposed and Draft — not settled policy

`Status: Proposed` marks a recommendation under consideration, NOT binding
policy. A Proposed file may be cited as "under consideration" or "the
current proposal" — never as "the rule," "governing behaviour," or
similar language that implies ratification. Code comments, guard advisory
text, and conversation MUST NOT assert that a Proposed file's rule is in
force. `Status: Draft` is earlier still — an in-progress write-up, not yet
offered for review — and carries no citable claim at all.

Unlike Locked, a Proposed (or Draft) file MAY be edited in place: fixing,
narrowing, or retracting an unratified proposal is normal, not a violation.

A Proposed file should not drift indefinitely. Every Proposed adjudication
should carry, or eventually receive, an explicit ratify-or-supersede
decision — Locked (ratified as-is), superseded by a new file (design
changed), or withdrawn (rejected) — rather than sitting Proposed forever
with no owner decision.

Recording a supersede or withdrawal decision means editing that Proposed (or
Draft) file's own `**Status:**` line to `Superseded` or `Withdrawn`, the same
way promotion to `Locked` does below. When superseding, also add a
`**Superseded-by:**` line naming the D### file(s) that replaced it plus a
one-line reason (see D001 for a worked example).

This is distinct from D093 retirement, which applies to a spent **Locked**
rule, not a Proposed one: retirement APPENDS a `**Retired:** YYYY-MM-DD —
<reason>` line and never touches `**Status:**`. Superseding rewrites the
Status line on the file being superseded; retiring never rewrites Status on
a Locked file. Do not conflate the two — editing a Locked file's Status line
to retire it would corrupt the lock.

Promoting Proposed → Locked means editing that file's `**Status:**` line to
`Locked`. This is a FILE MUTATION, made and verified the same way any other
capture is (see "Verify ground truth before you capture 'it works'" above)
— never a conversational assertion that a decision "is now Locked" without
the corresponding edit landing on disk.

## Verify ground truth before you capture "it works"

Deployed ≠ wired ≠ works. A green component/unit suite does NOT prove the
component is wired into its dispatcher or that the end-to-end path works —
add an integration assertion for each critical path. Before capturing a lesson
or adjudication that claims something "works", confirm ground truth. **Which
check proves that depends on where the claim's files live — this is two
cases, not one:**

- **Tracked source** (`hooks/`, `tools/`, `tests/`, `.claude/` — EXCLUDING
  `.claude/references/`, which is itself gitignored, see below): `git status
  --porcelain` remains the correct check — confirm the files changed, the
  claimed paths exist, and the relevant tests pass.
- **`docs/` captures** (adjudications, lessons, deviations, smoke — the whole
  corpus this file governs) **and `.claude/references/`**: both are gitignored
  (`.gitignore:26` is `/docs/`; `.gitignore:19` is `.claude/references/`) —
  confirmed with `git check-ignore -v --no-index <path>`, which shows the rule
  actually MATCHING a real file (stronger proof than quoting `.gitignore`
  alone), e.g.: `.gitignore:26:/docs/  docs/prism/adjudications/<file>.md`.
  The `--no-index` flag is required: plain `git check-ignore -v <path>` is
  silent (exit 1, no output) for a path that is currently TRACKED, even when
  a `.gitignore` rule matches it — git suppresses the match for indexed
  paths, so plain `check-ignore` cannot detect the tracked-but-ignored state
  that caused a real PII leak in this project (files matched by `.gitignore`
  were still tracked because ignore rules are not retroactive, and shipped).
  The complementary check for whether a file actually SHIPS is
  `git ls-files <path>` — gitignore status alone never tells you that. So
  `git status --porcelain` returns EMPTY for every write under either path —
  and that silence is **two opposite failure directions at once, not one**:
  - **False negative:** "git status shows nothing, so my capture never
    landed" → a correct write gets needlessly re-done or reported as failed.
  - **False positive — the dangerous one:** "git status is clean, so nothing
    changed / everything is verified" → an UNWRITTEN capture gets reported as
    **verified**. Taken literally, this convention would let a worker or chair
    assert "verified, tree clean" about a file that was never created. This
    is why the reason for this exception is spelled out inline, not left to
    inference: the wrong (simpler) instruction reads as MORE correct than the
    right one, so a future editor could "helpfully" collapse this back to one
    case unless the gitignore fact travels with the rule.

  Verify instead by reading the file back from disk — existence PLUS the
  specific line asserted, e.g.:
  - `test -f <path> && echo OK || echo MISSING` — did it get created at all.
  - `grep -m1 '^\*\*Status:\*\*' <path>` — confirms a ratification (Proposed →
    Locked) actually landed, not just that some file exists.
  - `wc -c <path>` (byte size) or `ls -la <path>` plus a `Read` — confirms a
    new capture has real content, not a stub or partial write.
  Never infer that a `docs/` (or `.claude/references/`) write landed, or
  failed, from `git status`/`git diff` alone.

Never trust a subagent's usage counter as a work/completion signal —
a delegating worker reports `tool_uses=1` while the real work lives in its
child's separate transcript. Measure artifacts, not counters or relayed prose.

**A PreToolUse gate enforces this on write** (`hooks/prism-capture-evidence-guard.mjs`,
`CLAIM_TRIGGER_RE`) — it blocks a captured-knowledge write that asserts a
factual claim ("confirmed", "reproduced", "root cause", etc. — read the regex
for the full list, it will rot if copied here) without a `**Verified:**`
field. The one rule to know up front: a claim under a NEW heading needs its
own `**Verified:**` field in that block — a header-level field elsewhere in
the file does not cover an appended section.

## A defect claim needs a shipped-code citation

An observed bug is not yet a filed defect. Before writing "X is broken", cite
the shipped file path + line range you READ that contains it. Behaviour seen in
an ad-hoc `node -e`, a one-off probe, or prose-only command-doc logic is an
OBSERVATION until confirmed — record it as such. A free-text caveat is not
enough; use a structural field that blocks promotion (see the cotest tracker's
`Shipped artifact:`). Worked examples: F12, F19 —
`docs/prism/lessons/2026-07-27-phantom-findings.md`.

## A prose-only command doc is not a shipped artifact — and some need a script anyway

A `commands/*.md` PROTOCOL section is executed by whichever model runs the
slash command each time, not by fixed code — do not cite it as a "shipped
artifact" backing a claim, and do not file a defect against its described
logic as if it were a tested code path (this is the same rule as the section
above, applied specifically to command docs). See [[D080]] (F12/F19).

Separately, when AUDITING whether a prose-only command doc is itself
acceptable (not filing a bug about it, but deciding if the surface should
stay prose-only): the deciding question is whether an unscripted run writes
persistent state another subsystem later reads as data — a read-only report
or a pure delegation wrapper is fine as prose; a doc that writes a file like
`roster.json` that other tooling trusts is not, because prose reconstructed
fresh per run is not guaranteed reproducible, and a divergence there fails
silently rather than visibly. See [[D088]] (F28, task #40) for the full
decision and the audited state of all 23 `commands/*.md` files as of
2026-07-28.
