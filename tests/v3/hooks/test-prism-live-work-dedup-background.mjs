#!/usr/bin/env node
// tests/v3/hooks/test-prism-live-work-dedup-background.mjs
//
// Regression test for F36 (task #53): the live-work-dedup guard fired twice on
// 2026-07-28 (session 7c96a3ea) with overlap scores computed ENTIRELY from
// boilerplate that no denylist contained:
//
//   1. 36% "overlap" between a CLI-unit-test dispatch (verdicts-coverage) and
//      an unrelated handoff-location task, on shared tokens:
//      check, content, date, docs, filename, look, memory, recent.
//   2. 32% "overlap" between a fresh dispatch and `team-lead` — the CHAIR
//      ITSELF — on: adjudications, alone, below, brief, capture, commands,
//      conventions, d087. i.e. advising the orchestrator to delegate to itself.
//
// The earlier F25/#37 fix added EXTRA_STOPWORDS, a hand-picked denylist drawn
// from ONE prior incident's vocabulary. None of the sixteen words above appear
// in it, or in the shared TASK_STOPWORDS — which is the point: a denylist
// generalises only to the incident that produced it.
//
// ROOT CAUSE: every PRISM dispatch carries the same auto-appended clause blocks
// and house vocabulary, so ANY two dispatches share a large common vocabulary
// BY CONSTRUCTION. An absolute similarity bar measures "is this a PRISM
// dispatch", not "is this the same work".
//
// FIX UNDER TEST (hooks/prism-live-work-dedup.mjs): score each candidate
// RELATIVE to the background that the same fresh dispatch scores against every
// OTHER live agent, and require MIN_EXCESS over that baseline.
//
// FIXTURES ARE REAL, NOT SYNTHETIC. Every string below is the verbatim dispatch
// text or accumulated ledger text from session 7c96a3ea, extracted from the
// transcript and the live-agents ledger. Synthetic boilerplate is exactly what
// let #37 look fixed while the defect survived, so this test refuses to use it.
//
// Paired true positives are mandatory: a fix that degenerates into "never fire"
// would pass the false-positive half and be worthless.
//
// Run: node tests/v3/hooks/test-prism-live-work-dedup-background.mjs

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(__dirname, '..', '..', '..', 'hooks');

const HOME = mkdtempSync(join(tmpdir(), 'prism-livework-background-'));
process.env.HOME = HOME; process.env.USERPROFILE = HOME;

const { run } = await import(pathToFileURL(join(HOOKS, 'prism-live-work-dedup.mjs')).href);
const { appendRecord, appendTaskSummary } =
  await import(pathToFileURL(join(HOOKS, 'lib', 'prism-live-agents.mjs')).href);

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; process.stdout.write(`  ok  ${name}\n`); }
  else { fail++; process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ''}\n`); }
}

const dispatch = (session_id, name, description, prompt) =>
  ({ tool_name: 'Agent', session_id, tool_input: { name, subagent_type: 'general-purpose', description, prompt } });
const advisoryOf = (r) => {
  if (!r.stdout) return '';
  try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext || ''; } catch { return ''; }
};

// The rendered advisory shows only hits.slice(0, 3), so asserting "agent X was
// not advised" against the NOTICE TEXT is unsound — X may be a real hit that
// merely lost the top-3 display cut. Assert against the routing log's
// overlap_hits instead: that is the complete, uncapped hit set.
function hitsOf(sid) {
  try {
    const p = join(HOME, '.claude', '.prism-routing.jsonl');
    const rows = readFileSync(p, 'utf-8').trim().split('\n')
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(e => e && e.event === 'live_work_dedup' && e.session_id === sid);
    return rows.length ? rows[rows.length - 1].overlap_hits : [];
  } catch { return []; }
}

// Seed the ledger to the exact live-agent set collectLiveWork() resolved at the
// incident timestamp: each agent's real taskText records (verbatim, one append
// per record — appendTaskSummary truncates at 600 chars, so seeding a 5-record
// agent like team-lead as one joined string would silently keep only its first
// 600 chars and stop reproducing the incident), plus a `running` status record
// so liveness does not depend on wall-clock TTL.
function seedLive(sid, docs) {
  for (const [id, texts] of Object.entries(docs)) {
    for (const t of texts) appendTaskSummary(HOME, sid, id, t);
    appendRecord(HOME, sid, { agentId: id, agentType: id, status: 'running', startedAt: new Date().toISOString() });
  }
}

// ── The eight agents live at 2026-07-28T09:54:39.718Z (FP1), each with the ──
// verbatim taskText records it held at that moment (id -> [record, ...]).
const LIVE_AT_FP1 = {
  "handoff-finder": [
    "Find and read latest handoff In the repo C:\\dev\\prism_3, find the most recent session HANDOFF document and report its full content.\n\nWhere to look (check all, report what you find):\n1. `C:\\dev\\prism_3\\docs\\prism\\lessons\\` — newest files by date in filename (e.g. 2026-07-28-*.md)\n2. `C:\\dev\\prism_3\\docs\\prism\\` — any file with \"handoff\" in the name (recursive glob **/*handoff*)\n3. `C:\\dev\\prism_3\\tasks\\` — any handoff/carryover files\n4. `C:\\Users\\devuser\\.claude\\.prism-sessions\\` — newest .md session summary files (sort by mtime, look at the 2-3 newest)\n5. `C:\\dev\\prism_3\\.claude\\agents\\MEMORY."
  ],
  "team-lead": [
    "READ-ONLY investigation complete. No edits made.\n\n## Handoff document found (the one to use)\n\n**Path:** `C:\\dev\\prism_3\\docs\\prism\\plans\\2026-07-28-SESSION-HANDOFF.md`\n**Status:** Draft | **Date:** 2026-07-28 | **Captured by:** /prism-clean Step 4b (chair-written)\n**Modification timestamp evidence:** the companion auto-generated session summary `C:\\Users\\devuser\\.claude\\.prism-sessions\\deadbeef-face-cafe-0000-deadbeefcafe.md` (which lists this handoff among \"Files touched\") has mtime **Jul 28 11:51**, the newest artifact in `.prism-sessions/`. The prior handoff it supersedes is `docs/prism/pla",
    "## 1. Premise verification: CONFIRMED\n\n`writeMemoryMdAtomic` — `tools/prism-clean.mjs:172-181` — did exactly what F33 alleges: `writeFileSync(tmp, body, 'utf8')` then a bare `renameSync(tmp, path)`, no try/catch, no retry. `git log --oneline -- tools/prism-clean.mjs` shows nothing since D083 (b9e6067be) touched this. Not fixed, not phantom.\n\nAlso found during premise-check: `tools/lib/prism-state.mjs` already had a tested `renameWithRetry(renameFn, tmp, dst, {retries=5, delayMs=25})` helper (D083-era, covering only `.prism-state.json`) with 3 passing tests in `tests/v3/state/test-prism-state.m",
    "Re-validation notification for task #28 received. Verified the prior work is still intact in `C:\\dev\\prism-uat-scratch`: `git status --porcelain` shows the same 2 modified files + 1 untracked file as before (`M tools/notifications/dispatcher.mjs`, `M tools/payments/charge-queue.mjs`, `?? FIXTURE-NOTES.md`), and a grep for `INTENTIONAL FIXTURE BUG` still hits exactly those 3 files, nothing extraneous. Nothing was lost or reverted.\n\nOne thing was genuinely new in this re-validation: the note that the `.test.mjs` companions don't exercise either broken path. I checked this myself rather than trus",
    "Task #41/F29 done. Both mechanical fixes shipped, tests green, prepared decision table below — no Status fields changed.\n\n## Fix 1 — capture-conventions.md now defines Proposed/Draft\n\nFile: C:\\dev\\prism_3\\.claude\\rules\\capture-conventions.md, new section inserted immediately after \"## Locking\" (exact text added):\n\n```\n## Proposed and Draft — not settled policy\n\n`Status: Proposed` marks a recommendation under consideration, NOT binding\npolicy. A Proposed file may be cited as \"under consideration\" or \"the\ncurrent proposal\" — never as \"the rule,\" \"governing behaviour,\" or\nsimilar language that im",
    "F28 / Task #40 report. Repo: C:\\dev\\prism_3, branch main. No commits made. Only file touched: commands/prism-telemetry.md.\n\n## STEP 0 — re-verification result: filing is ACCURATE, not overstated\n\n`ls commands/*.md | wc -l` = 23. Confirmed.\n\nPer-command verified status (grepped every tools/*.mjs for plausible matches, read the actual source of every candidate, not just filenames):\n\n| Command | Filed as | Verified status |\n|---|---|---|\n| prism-roster | prose-only | **CONFIRMED prose-only for its documented behavior.** `tools/prism-roster.mjs` exists but implements a completely different feature"
  ],
  "eperm-sweep": [
    "Fix #47 EPERM rename retry sweep Repo: C:\\dev\\prism_3 (Node.js ESM, dependency-free hooks/tools). Branch `main`, clean tree. Windows 11 + Git Bash.\n\n# Task #47 (finding F33) — bounded EPERM retry around atomic tmp+rename writes\n\n## The defect as filed\n`writeMemoryMdAtomic` (cited as `tools/prism-clean.mjs:172-181`) does a tmp-write + `renameSync` with NO retry. On Windows a transient `EPERM`/`EACCES`/`EBUSY` from an antivirus or search-indexer handle collision aborts a real `/prism-clean` capture AFTER the session's durable knowledge has been assembled but BEFORE it lands — the lesson is lost "
  ],
  "comment-nit": [
    "Fix inaccurate busy-spin comment Single surgical comment fix in C:\\dev\\prism_3\\tools\\lib\\atomic-fs.mjs.\n\nLines 46-52 currently read:\n\n      // Synchronous backoff (callers are sync/hook-lifecycle code, per\n      // CLAUDE.local task constraints these must not become async):\n      // Atomics.wait on a throwaway buffer blocks this thread without an\n      // event-loop trip. If Atomics.wait is unavailable, fall through to a\n      // busy spin rather than skipping the backoff entirely.\n      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs * attempt); }\n      catch { /* f"
  ],
  "d087-identity": [
    "D087 agent-teams identity decision brief Repo: C:\\dev\\prism_3. Branch main, clean tree. THIS TASK IS READ-ONLY. You will produce a DECISION BRIEF. You must NOT edit any code.\n\n# Task #49 — agent-teams has no caller-identity dimension (D087 umbrella)\n\n## The thesis you are testing\nThree separately-filed PRISM findings are, I believe, ONE structural gap: under agent-teams, session-scoped state and dispatch plumbing are keyed by `sessionId` ALONE, with no caller/actor dimension. Nothing records WHICH actor wrote a value or received a directive. Your job is to confirm or REFUTE that thesis, then l",
    "Additional LIVE EVIDENCE for your #49 investigation — observed in this session minutes ago, not from a log.\n\nA named teammate (`uat-fixtures`) sent me a message via SendMessage. That delivery carried the dispatch-preamble clauses 1-8, INCLUDING clause 8 verbatim:\n\n  \"8. You are a NAMED teammate — your output does NOT return to the caller as a tool result, only a payload-free idle_notification does. You MUST call SendMessage yourself to deliver your findings before going idle. Plain-text output with no SendMessage, or silence, is a FAILED result, not a completed one.\"\n\nContrast with what I obse"
  ],
  "uat-fixtures": [
    "Document planted bugs in uat-scratch SCOPE WARNING — READ FIRST. Your entire working scope is `C:\\dev\\prism-uat-scratch`. That is a DIFFERENT repository from `C:\\dev\\prism_3`. You must NOT create, edit, or commit any file under `C:\\dev\\prism_3`. Do not commit anything at all; leave changes in the working tree.\n\n# Task #28 — document the deliberately-planted bugs in the co-test fixture repo\n\n## Context\n`C:\\dev\\prism-uat-scratch` is a synthetic fixture repo used for PRISM co-testing. It contains bugs that were PLANTED ON PURPOSE so that PRISM's guards and reviewers can be exercised against known"
  ],
  "proposed-status": [
    "Fix Proposed-adjudication governance gap Repo: C:\\dev\\prism_3. Branch main, clean tree.\n\n# Task #41 / F29 — \"Proposed\" adjudications are being cited as settled policy\n\n## The defect\n`.claude/rules/capture-conventions.md` defines what **Locked** means (referenced in CLAUDE.md, never edited in place) but says NOTHING about what **Proposed** obliges or permits. As a result, Proposed adjudications get cited in conversation and in code comments as though they were settled policy. The population is now SEVEN, all still Proposed: **D043, D080, D081, D082, D084, D085, D086**.\n\nConcrete harm observed: "
  ],
  "command-backing": [
    "Audit prose-only slash commands Repo: C:\\dev\\prism_3. Branch main, clean tree.\n\n# Task #40 / F28 — slash commands with no backing script\n\n## The defect as filed\n6 of 23 `commands/*.md` files are PROSE-ONLY: they describe behaviour that no script implements, so the behaviour is improvised by the model each time it runs. Named: `prism-roster`, `prism-audit` (partial), **`prism-index` (highest stakes — writes `roster.json` by pure prose)**, `prism-archive`, `prism-deps`, `prism-recommend`.\n\nWhy `prism-index` is the worst: `roster.json` is real persisted state that other machinery reads. Having it"
  ]
};

// ── The nine agents live at 2026-07-28T10:05:45.013Z (FP2). team-lead (the ──
// chair) carries 5 records: its scope is the UNION of everything SendMessage
// assigned it, which is why it overlaps every dispatch in the batch.
const LIVE_AT_FP2 = {
  "handoff-finder": [
    "Find and read latest handoff In the repo C:\\dev\\prism_3, find the most recent session HANDOFF document and report its full content.\n\nWhere to look (check all, report what you find):\n1. `C:\\dev\\prism_3\\docs\\prism\\lessons\\` — newest files by date in filename (e.g. 2026-07-28-*.md)\n2. `C:\\dev\\prism_3\\docs\\prism\\` — any file with \"handoff\" in the name (recursive glob **/*handoff*)\n3. `C:\\dev\\prism_3\\tasks\\` — any handoff/carryover files\n4. `C:\\Users\\devuser\\.claude\\.prism-sessions\\` — newest .md session summary files (sort by mtime, look at the 2-3 newest)\n5. `C:\\dev\\prism_3\\.claude\\agents\\MEMORY."
  ],
  "team-lead": [
    "F28 / Task #40 report. Repo: C:\\dev\\prism_3, branch main. No commits made. Only file touched: commands/prism-telemetry.md.\n\n## STEP 0 — re-verification result: filing is ACCURATE, not overstated\n\n`ls commands/*.md | wc -l` = 23. Confirmed.\n\nPer-command verified status (grepped every tools/*.mjs for plausible matches, read the actual source of every candidate, not just filenames):\n\n| Command | Filed as | Verified status |\n|---|---|---|\n| prism-roster | prose-only | **CONFIRMED prose-only for its documented behavior.** `tools/prism-roster.mjs` exists but implements a completely different feature",
    "Follow-up on F28/task #40: a teammate (handoff-finder, later shown as owner `command-backing-worker` on #40) did a second pass after my report and landed 3 more artifacts. I independently verified all three on disk (not relaying blind):\n\n1. `commands/prism-telemetry.md` — further edited on top of mine, now cites both `tools/prism-telemetry-aggregate.mjs` and `tools/prism-bootstrap.mjs`, plus lists the aggregate script's flags that map to no subcommand. Confirmed present, reads correctly, doesn't clobber my earlier edit.\n2. `docs/prism/adjudications/D088-prose-only-command-docs-need-a-backing-s",
    "F30 done. Full report below.\n\n## STEP 0 — re-verification result\nPremise CONFIRMED TRUE. Grepped `tests/` for `prism-phase-1-5-verdicts` (the artifact filename): 17 hits, matching the prior claim exactly. Then grepped specifically for `prism-phase-1-5-verdicts\\.mjs` (the actual script) across `tests/`: **zero matches**. Manually inspected every one of the 17 hits — all reference `.prism-phase-1-5-verdicts.jsonl`/`.prism-phase-1-5-verdicts-<sha>.json` purely as a fixture artifact consumed by OTHER tools' tests (test-prism-model-ratchet-behavior.mjs, test-phase-1-5-payload.mjs, test-prism-phase-",
    "Task #49 D087 decision brief — COMPLETE. Written to `C:\\dev\\prism_3\\docs\\prism\\plans\\2026-07-28-D087-identity-options.md` (490 lines, Status: Draft). Read-only constraint held: I made zero edits. NOTE — `git status` is dirty (MEMORY.md, capture-conventions.md, prism-telemetry.md, memory-heal.mjs, an untracked verdicts test). None of that is mine; it is other concurrent teammates' work. Do not attribute it to #49.\n\n# 1. VERDICT ON THE THESIS: CONFIRMED 2 of 3, REFUTED for #43\n\n| Symptom | Shared state? | Concurrent writers? | Keyed by sessionId alone? | Thesis |\n|---|---|---|---|---|\n| #44 sent",
    "Tested your clause-8 observation against source as you asked. Brief updated — new §2b at `C:\\dev\\prism_3\\docs\\prism\\plans\\2026-07-28-D087-identity-options.md` (now 592 lines). Still read-only; the dirty `git status` remains other teammates' work, not mine.\n\n**Your conclusion is right. The specific evidence you cited does not support it, and testing it surfaced something worse.**\n\n## REFUTED — the rewrite travels the other way\n\n`runSendMessage()` line 113 returns `updatedInput: {...ti, message: message + ...}`. `ti` is the **sender's** `tool_input`, so the hook rewrites the **outbound** message"
  ],
  "eperm-sweep": [
    "Fix #47 EPERM rename retry sweep Repo: C:\\dev\\prism_3 (Node.js ESM, dependency-free hooks/tools). Branch `main`, clean tree. Windows 11 + Git Bash.\n\n# Task #47 (finding F33) — bounded EPERM retry around atomic tmp+rename writes\n\n## The defect as filed\n`writeMemoryMdAtomic` (cited as `tools/prism-clean.mjs:172-181`) does a tmp-write + `renameSync` with NO retry. On Windows a transient `EPERM`/`EACCES`/`EBUSY` from an antivirus or search-indexer handle collision aborts a real `/prism-clean` capture AFTER the session's durable knowledge has been assembled but BEFORE it lands — the lesson is lost "
  ],
  "comment-nit": [
    "Fix inaccurate busy-spin comment Single surgical comment fix in C:\\dev\\prism_3\\tools\\lib\\atomic-fs.mjs.\n\nLines 46-52 currently read:\n\n      // Synchronous backoff (callers are sync/hook-lifecycle code, per\n      // CLAUDE.local task constraints these must not become async):\n      // Atomics.wait on a throwaway buffer blocks this thread without an\n      // event-loop trip. If Atomics.wait is unavailable, fall through to a\n      // busy spin rather than skipping the backoff entirely.\n      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs * attempt); }\n      catch { /* f"
  ],
  "d087-identity": [
    "D087 agent-teams identity decision brief Repo: C:\\dev\\prism_3. Branch main, clean tree. THIS TASK IS READ-ONLY. You will produce a DECISION BRIEF. You must NOT edit any code.\n\n# Task #49 — agent-teams has no caller-identity dimension (D087 umbrella)\n\n## The thesis you are testing\nThree separately-filed PRISM findings are, I believe, ONE structural gap: under agent-teams, session-scoped state and dispatch plumbing are keyed by `sessionId` ALONE, with no caller/actor dimension. Nothing records WHICH actor wrote a value or received a directive. Your job is to confirm or REFUTE that thesis, then l",
    "Additional LIVE EVIDENCE for your #49 investigation — observed in this session minutes ago, not from a log.\n\nA named teammate (`uat-fixtures`) sent me a message via SendMessage. That delivery carried the dispatch-preamble clauses 1-8, INCLUDING clause 8 verbatim:\n\n  \"8. You are a NAMED teammate — your output does NOT return to the caller as a tool result, only a payload-free idle_notification does. You MUST call SendMessage yourself to deliver your findings before going idle. Plain-text output with no SendMessage, or silence, is a FAILED result, not a completed one.\"\n\nContrast with what I obse"
  ],
  "uat-fixtures": [
    "Document planted bugs in uat-scratch SCOPE WARNING — READ FIRST. Your entire working scope is `C:\\dev\\prism-uat-scratch`. That is a DIFFERENT repository from `C:\\dev\\prism_3`. You must NOT create, edit, or commit any file under `C:\\dev\\prism_3`. Do not commit anything at all; leave changes in the working tree.\n\n# Task #28 — document the deliberately-planted bugs in the co-test fixture repo\n\n## Context\n`C:\\dev\\prism-uat-scratch` is a synthetic fixture repo used for PRISM co-testing. It contains bugs that were PLANTED ON PURPOSE so that PRISM's guards and reviewers can be exercised against known"
  ],
  "proposed-status": [
    "Fix Proposed-adjudication governance gap Repo: C:\\dev\\prism_3. Branch main, clean tree.\n\n# Task #41 / F29 — \"Proposed\" adjudications are being cited as settled policy\n\n## The defect\n`.claude/rules/capture-conventions.md` defines what **Locked** means (referenced in CLAUDE.md, never edited in place) but says NOTHING about what **Proposed** obliges or permits. As a result, Proposed adjudications get cited in conversation and in code comments as though they were settled policy. The population is now SEVEN, all still Proposed: **D043, D080, D081, D082, D084, D085, D086**.\n\nConcrete harm observed: "
  ],
  "command-backing": [
    "Audit prose-only slash commands Repo: C:\\dev\\prism_3. Branch main, clean tree.\n\n# Task #40 / F28 — slash commands with no backing script\n\n## The defect as filed\n6 of 23 `commands/*.md` files are PROSE-ONLY: they describe behaviour that no script implements, so the behaviour is improvised by the model each time it runs. Named: `prism-roster`, `prism-audit` (partial), **`prism-index` (highest stakes — writes `roster.json` by pure prose)**, `prism-archive`, `prism-deps`, `prism-recommend`.\n\nWhy `prism-index` is the worst: `roster.json` is real persisted state that other machinery reads. Having it",
    "Task #40 (F28 — prose-only command docs) is done. Flagging one thing first: the tracker showed #40 as \"completed\" partway through my work, before two of the three DONE WHEN deliverables existed on disk (the adjudication and the capture-conventions update). That was premature — I kept going and it is now genuinely true. No action needed from you, just noting it per this session's own D057/verify-ground-truth discipline (don't trust a status flag over the artifact).\n\nWHAT LANDED (all read-verified, not relayed):\n\n1. **commands/prism-telemetry.md** — added a `Backing implementation:` line citing "
  ],
  "verdicts-coverage": [
    "F30 test coverage for verdicts CLI PRISM-LEASE: agent=verdicts-coverage files=tools/prism-phase-1-5-verdicts.mjs,tests/v3/tools/test-prism-phase-1-5-verdicts.mjs\nDo NOT read-modify-write any file outside that lease. Three other agents are running concurrently on .claude/rules/, commands/, docs/prism/plans/, MEMORY.md, tools/lib/memory-heal.mjs and tools/prism-knowledge-index.mjs — stay out of all of those.\n\nRepo: C:\\dev\\prism_3. Branch main.\n\n# Task #42 / F30 — the 30-day window in prism-phase-1-5-verdicts.mjs has zero test coverage\n\n## The finding\n`tools/prism-phase-1-5-verdicts.mjs` implemen"
  ]
};

// The verbatim fresh dispatch text (description + prompt) of each incident.
// NOTE (2026-07-29, task #86 census): FRESH_FP2 below quotes a real past
// dispatch verbatim, including "Make the fail-open path OBSERVABLE per D086"
// and "promote D043 from `Status: Proposed` to `Status: Locked`". These are
// testimony about what was actually said at the time (D086 genuinely WAS
// cited that way then) — NOT a present-day assertion that D086 governs.
// Per capture-conventions.md this is the historical/meta-reference exception
// (same class as memory-heal.mjs's D047/D086/D093 self-citation comment): a
// verbatim fixture is not a policy claim. Do NOT reword this string in a
// future Proposed-citation sweep — that would falsify the historical record.
const FRESH_FP1 = "F30 test coverage for verdicts CLI PRISM-LEASE: agent=verdicts-coverage files=tools/prism-phase-1-5-verdicts.mjs,tests/v3/tools/test-prism-phase-1-5-verdicts.mjs\nDo NOT read-modify-write any file outside that lease. Three other agents are running concurrently on .claude/rules/, commands/, docs/prism/plans/, MEMORY.md, tools/lib/memory-heal.mjs and tools/prism-knowledge-index.mjs — stay out of all of those.\n\nRepo: C:\\dev\\prism_3. Branch main.\n\n# Task #42 / F30 — the 30-day window in prism-phase-1-5-verdicts.mjs has zero test coverage\n\n## The finding\n`tools/prism-phase-1-5-verdicts.mjs` implements a 30-day reporting window. It has NO test exercising it. A prior grep produced 17 hits that LOOKED like coverage, but every one of them merely references the verdicts artifact FILE as a fixture for some other test — none actually invokes this CLI. So the window logic, the date parsing, and the exit codes are all unverified.\n\n## STEP 0 — RE-VERIFY FIRST (mandatory, non-negotiable)\nThis project has repeatedly been burned by findings that were already fixed or mis-measured — three in recent memory. Before writing a single test:\n1. Read `tools/prism-phase-1-5-verdicts.mjs` IN FULL. Establish what it actually does: its flags, its default window, its exit codes, its output shapes.\n2. `git log --oneline -- tools/prism-phase-1-5-verdicts.mjs` — has anyone already added coverage?\n3. Search `tests/` for anything that actually SPAWNS this CLI (not merely mentions the artifact filename). Confirm or refute the \"17 hits, 0 real coverage\" claim and report the true number.\n4. If coverage already exists, STOP and report that. \"The premise is wrong\" is a valid and valuable outcome — do NOT manufacture redundant tests to look productive.\n\n## STEP 1 — write the tests\nCreate `tests/v3/tools/test-prism-phase-1-5-verdicts.mjs` covering at minimum:\n- the DEFAULT 30-day window (what is included, what is excluded at the boundary);\n- `--since` with a valid date;\n- `--since` with an INVALID date -> must exit 2 (verify the real exit code by reading the source, do not assume 2 if the code says otherwise — report the discrepancy instead);\n- `--uncited-rate`;\n- `--json` output shape.\n\n## CRITICAL TEST-DESIGN CONSTRAINT\n**Derive every timestamp from `Date.now()` at run time. NEVER use calendar literals.** A test that hardcodes e.g. \"2026-07-01\" silently changes meaning as real time passes and will mysteriously break months later. Build fixture dates as offsets from now (now - 5 days, now - 29 days, now - 31 days, and one straddling the exact boundary). This is the single most important design rule for this task.\n\nAlso:\n- The test MUST be discovered by `bash tests/v3/run-all.sh`. Discovery is `git ls-files`-based, so a gitignored path is INVISIBLE to the runner. VERIFY your new file is discoverable — run `git check-ignore -v <path>` and `git ls-files --cached --others --exclude-standard -- \"tests/v3/*.mjs\" | grep <yourfile>`. This exact trap invalidated a previous finding (#39); do not repeat it.\n- Isolate fixtures from the real `~/.claude` / real HOME. A prior finding (#33) was fixture sentinels polluting production state. Use a temp dir.\n- Match the existing test style in `tests/v3/tools/` — read a neighbouring test file first and follow its conventions (assertion helper, pass/fail output format, exit code).\n\n## Constraints\n- Use Edit/Write tools for file changes. NOT Bash/PowerShell redirection — `Set-Content`/`Out-File`/`>` emit UTF-8 with BOM and corrupt files.\n- Prefer NOT modifying `prism-phase-1-5-verdicts.mjs` at all. If a test reveals a genuine BUG in it, report the bug with a file:line citation and ASK before changing behaviour — do not silently \"fix\" production logic to make a test pass.\n- Do NOT commit.\n- Do NOT run the full `run-all.sh` (~6 min, exceeds tool timeout). Run your own file only.\n\n## Reporting requirement\nThere is a known PRISM defect (#43) where the report-back instruction does not reach agents dispatched this way, so I state it manually: **you MUST send me a full prose report when done.** Include: the STEP 0 re-verification result with the true count of real vs apparent coverage, the actual flags/exit codes you read from the source, verbatim test output, proof the file is runner-discoverable (paste the git commands and their output), and any bug you found but did NOT fix. Do not finish with a bare \"done\".";
const FRESH_FP2 = "Author D087 and fix 44 PRISM-LEASE: files=hooks/prism-parent-dispatch-guard.mjs,hooks/prism-prompt-tier-router.mjs,docs/prism/adjudications/D087-*.md,docs/prism/adjudications/D043-*.md,tests/v3/hooks/test-sentinel-chair-only.mjs\nThree other agents run concurrently on hooks/prism-dispatch-preamble.mjs, tools/prism-capability-learn.mjs and agents/agent-factory.md. Stay out of those.\n\nRepo: C:\\dev\\prism_3. The owner has APPROVED the plan below. Read `docs/prism/plans/2026-07-28-D087-identity-options.md` (592 lines) FIRST — it is the full investigation and contains every measurement referenced here.\n\n# APPROVED: author D087 + implement the #44 fix + promote D043\n\n## Owner decisions already made (do not re-litigate)\n1. The D087 umbrella is SPLIT THREE WAYS. D087 covers **#44 + D043 only**. #43 is NOT an identity defect (it is a stateless text-routing/budget issue) and is being handled by a different agent in a separate adjudication. #38 folds into D087 as a documented sub-case.\n2. For #44: adopt **option (c) — chair-writable-only sentinel**.\n3. For D043 / borrowed_unlock: adopt **option (d) — accept as a documented limitation** — AND promote D043 from `Status: Proposed` to `Status: Locked`, framed as an accepted-limitation ratification. This retires one of the seven Proposed files tracked in task #41.\n\n## PART 1 — the #44 code fix (option c, narrow)\nTwo sites, per the brief:\n- `hooks/prism-parent-dispatch-guard.mjs` lines ~418-421: the sentinel exemption matching `/[/\\\\]\\.prism-turn-tier-[^/\\\\]*\\.json$/` returns `done(0)` unconditionally with no caller check. Gate it on `process.env.CLAUDE_CODE_CHILD_SESSION !== '1'` so a TEAMMATE cannot write the shared sentinel, while the CHAIR still can.\n- `hooks/prism-prompt-tier-router.mjs` line ~161 `buildOverrideDirective()`: suppress the override directive for teammates, so the system stops INSTRUCTING an actor to do what it now blocks. Emitting an instruction you then deny is worse than either alone.\n\n### NON-NEGOTIABLE CONSTRAINTS\n- **MUST FAIL OPEN.** If the env var is absent, unreadable, or the check throws, ALLOW the write. A closed failure re-creates the FIX-A deadlock documented in the comment at lines 411-417 (without the exemption the documented override escape is unreachable and the turn deadlocks) and violates the D039/D043 fail-safe convention.\n- **QUOTE THE FIX-A COMMENT** (lines ~411-417) in your report before you touch that block. It is load-bearing and explains why the exemption exists. You are NARROWING it, not removing it.\n- Do NOT implement the \"separate non-broadcasting request channel\" — the owner deferred it as scope creep. #44's own evidence is that the teammate write was an ERROR, not a legitimate need.\n- Do NOT touch `hooks/prism-mutation-guard.mjs`. The brief established its sentinel exemption at line 369 is effectively DEAD (it reads `tool_input.file_path`, which a Bash payload does not carry, and every non-Bash tool already returned at line 292). The ACTIVE permit is the dispatch-guard's at 420. Document this; do not \"symmetrise\" it.\n- Make the fail-open path OBSERVABLE per D086: a fault must be structurally distinguishable from a healthy path. Do not just silently allow.\n\n## PART 2 — tests (TDD, RED first)\nNew `tests/v3/hooks/test-sentinel-chair-only.mjs`:\n- RED first: prove a teammate-shaped write is currently ALLOWED with no stdout (the brief reproduced exactly this: both guards `exit=0 ALLOWED`, no advisory, no log line).\n- Then: teammate write is DENIED after the fix; chair write still ALLOWED; env var ABSENT -> ALLOWED (fail-open); env read throwing -> ALLOWED (fail-open).\n- Isolate HOME to a temp dir (finding #33: fixture sentinels polluted production state).\n- MUST be runner-discoverable: verify with `git check-ignore -v <path>` (expect exit 1, no output) and `git ls-files --cached --others --exclude-standard -- \"tests/v3/*.mjs\" | grep <yourfile>`. This trap invalidated finding #39. Verify, don't assume.\n\n## PART 3 — author D087\n`docs/prism/adjudications/D087-<short-slug>.md`. Follow `.claude/rules/capture-conventions.md` exactly: required header block, `**Status:**`, `**Date:** 2026-07-28`, `**Captured by:**`, `**Related:**`, and a one-line `**Rule:**` imperative (extracted verbatim by the recall machinery — make it actionable). Add a `**Verified:**` line with real commands and their real output.\nContent must record: the thesis verdict (CONFIRMED for #44/D043, REFUTED for #43, with the reason — stateless hook, no shared state); why option (c) over (a)/(b)/(d); that per-actor identity does NOT exist and `CLAUDE_CODE_CHILD_SESSION` is only a chair/teammate BINARY; the writer inventory including **writer #6, the conversation model itself via buildOverrideDirective**, which a grep-only inventory misses; and the second-order finding that the exemption returns BEFORE the `borrowed_unlock` block at 592-613, making the sentinel write **invisible to D043's own instrumentation**. Fold #38 in as a sub-case: parent-dispatch-guard has 13 teams-handling hits vs mutation-guard's 0, but mutation-guard is Bash-write-only since v5.4.0 (line 292, `MUTATION_TOOLS` empty at 69-76) and treats `dispatched===true` as pass-through rather than an unlock to audit — narrower BY CONSTRUCTION, not by oversight.\nD087 is the number RESERVED for this. D088 already exists (a different, unrelated adjudication) — do not renumber it.\n\n## PART 4 — promote D043\nEdit ONLY the `**Status:**` line of the D043 file: `Proposed` -> `Locked`. Add a short note recording that it is ratified as an ACCEPTED LIMITATION (borrowed_unlock cannot be fixed without per-actor identity, which does not exist), that D087 supersedes its #44 portion, and the ratification date. Do not rewrite its analysis.\n\n## Hard constraints\n- Use **Edit/Write tools** for every change. NOT Bash/PowerShell redirection — `Set-Content`/`Out-File`/`>` emit UTF-8 with BOM and corrupt these files.\n- **DO NOT RUN `node tools/prism-installer.mjs install`.** Per D081 deployment is a single orchestrator-owned step and three other agents are live in this tree. You may run `verify` (read-only). I will deploy after the batch. Note this means your hook changes are NOT active in `~/.claude` while you test — test the repo copy directly, and say so.\n- Do NOT commit.\n- Karpathy discipline: surgical, minimal. No speculative abstractions.\n\n## Report\nReturn a full prose report as your final message: the FIX-A comment quoted verbatim before modification; exact diffs applied; RED-then-GREEN test output verbatim; discoverability proof commands + output; the D087 `**Rule:**` line you wrote; confirmation of the D043 status edit; and anything you found but deliberately did NOT change.";

// Verbatim briefs re-dispatched as GENUINE duplicates for the true-positive half.
const FRESH_TP_EPERM = "Fix #47 EPERM rename retry sweep Repo: C:\\dev\\prism_3 (Node.js ESM, dependency-free hooks/tools). Branch `main`, clean tree. Windows 11 + Git Bash.\n\n# Task #47 (finding F33) — bounded EPERM retry around atomic tmp+rename writes\n\n## The defect as filed\n`writeMemoryMdAtomic` (cited as `tools/prism-clean.mjs:172-181`) does a tmp-write + `renameSync` with NO retry. On Windows a transient `EPERM`/`EACCES`/`EBUSY` from an antivirus or search-indexer handle collision aborts a real `/prism-clean` capture AFTER the session's durable knowledge has been assembled but BEFORE it lands — the lesson is lost silently. Confirmed flaky: 5/5 passes standalone, reproduced only under full-suite concurrent load. NOT a regression from the recent D083 work.\n\n## STEP 0 — RE-VERIFY THE PREMISE BEFORE FIXING (mandatory)\nThis project has a standing rule, earned the hard way: three recent findings turned out to be already-fixed, mis-measured, or describing code that never existed. Before you write a line:\n1. Read `tools/prism-clean.mjs` around the cited lines. Confirm `writeMemoryMdAtomic` exists, at what line range, and that it genuinely lacks retry. Report the ACTUAL line numbers.\n2. `git log --oneline -- tools/prism-clean.mjs` — check nobody already fixed this.\n3. If the premise is wrong, STOP and report that. \"No bug\" is a valid, valuable outcome. Do not invent work to justify the dispatch.\n\n## STEP 1 — SURVEY ALL SITES, FIX AS ONE SWEEP\nThe handoff is explicit: do NOT patch `prism-clean.mjs` alone. Find every tmp-write+rename durability site in the repo and fix them together, or the same bug just resurfaces elsewhere. Known/suspected siblings to check:\n- `tools/lib/memory-heal.mjs`\n- the tier-router session-sentinel write (search `hooks/` for the `.prism-turn-tier-` writer)\n- anything else: grep `hooks/ tools/` for `renameSync`, `rename(`, `.tmp`, `writeFileSync` followed by a rename.\nReport the complete inventory with file:line for each before you change anything.\n\n## STEP 2 — THE FIX\nExtract ONE shared helper (dependency-free, ESM) rather than copy-pasting a retry loop N times. Place it wherever this repo's shared lib convention puts it (look at `hooks/lib/` and `tools/lib/` — follow existing precedent, e.g. how `hooks/lib/prism-home.mjs` is structured and imported).\n\nSemantics — be strict:\n- Retry ONLY on `EPERM`, `EACCES`, `EBUSY`. Rethrow every other error code immediately and unchanged.\n- Bounded attempts with short backoff (propose the numbers and justify them — this is your domain; a Windows AV handle typically clears in tens of ms, so justify the ceiling against that, not against a guess).\n- Preserve the original error (code + message) when the retry budget is exhausted — the failure must stay diagnosable, not become \"rename failed after retries\".\n- Sync vs async: match each call site's existing style; do not convert sync call sites to async (these run inside hooks with strict lifecycles).\n- Do NOT swallow the failure. This is a durability path; fail-open here would silently lose the very data we're protecting.\n\n## STEP 3 — TESTS (TDD — write the RED test first)\n- Write a failing test that proves the bug BEFORE the fix: inject a `renameSync` that throws `EPERM` on the first N calls then succeeds. Confirm it fails against current code, then fix, then confirm green.\n- Add a test asserting a NON-retryable code (e.g. `ENOSPC`) is rethrown immediately and is NOT retried.\n- Add a test asserting the retry budget is bounded (does not loop forever) and that the original error survives exhaustion.\n- CRITICAL: the test must be discovered by `bash tests/v3/run-all.sh`. Discovery is `git ls-files`-based, so a gitignored file is INVISIBLE to the runner. Verify your new test actually appears in the runner's discovery — a recent finding (#39) was precisely \"the one relevant test is gitignored AND excluded from run-all.sh\". Confirm, don't assume.\n- Tests must not depend on real wall-clock calendar literals or on the real HOME; isolate fixtures.\n\n## STEP 4 — VERIFY (evidence, not assertions)\n- `node <your-test-file>.mjs` → green, paste output.\n- If you touched anything under `hooks/` or `tools/lib/`: you MUST run `node tools/prism-installer.mjs install` BEFORE verifying, because `hooks/prism-session-start.mjs` imports the INSTALLED copy, not the repo copy. Verifying without deploying tests the old code and produces a false green.\n- `node tools/prism-installer.mjs verify` → expect `0 drift`, paste output.\n- Do NOT run the full `tests/v3/run-all.sh` suite — it takes ~6 min and exceeds the tool timeout. Run your own test file plus any directly-related existing test. Note: the full suite has exactly ONE expected permanent failure (`dispatch-preamble.test.mjs` assertion 6e, locked per D057 §6) — never \"fix\" that one.\n\n## Constraints\n- Use the **Edit/Write tools** for all file changes — NOT Bash/PowerShell redirection. PowerShell's `Set-Content`/`Out-File`/`>` emit UTF-8 **with BOM**, which corrupts these files.\n- Keep it dependency-free. No npm packages.\n- Do NOT commit. Leave changes in the working tree for my review.\n- Surgical changes only — do not refactor adjacent code you weren't asked to touch.\n\n## Report back\n1. Premise verification result (confirmed / wrong), with actual file:line citations you READ.\n2. Full inventory of tmp+rename sites found.\n3. The helper's design + your justification for the attempt count and backoff.\n4. Files changed (exact paths).\n5. Verbatim test output and verify output.\n6. Anything you found but deliberately did NOT fix, and why.";
const FRESH_TP_CMDBACK = "Audit prose-only slash commands Repo: C:\\dev\\prism_3. Branch main, clean tree.\n\n# Task #40 / F28 — slash commands with no backing script\n\n## The defect as filed\n6 of 23 `commands/*.md` files are PROSE-ONLY: they describe behaviour that no script implements, so the behaviour is improvised by the model each time it runs. Named: `prism-roster`, `prism-audit` (partial), **`prism-index` (highest stakes — writes `roster.json` by pure prose)**, `prism-archive`, `prism-deps`, `prism-recommend`.\n\nWhy `prism-index` is the worst: `roster.json` is real persisted state that other machinery reads. Having it written by model improvisation rather than a deterministic tool means its schema and contents can drift arbitrarily between runs.\n\n## STEP 0 — RE-VERIFY BEFORE YOU BUILD ANYTHING\nThis project has repeatedly been burned by findings that were already fixed or mis-measured. Before proposing work:\n- List all `commands/*.md` and confirm the count (filed as 23).\n- For EACH of the six named, check whether a backing script actually exists — grep `tools/` for a plausibly-matching `.mjs`. A command is only \"prose-only\" if no tool implements it. Report the ACTUAL status per command; correct the filed list if it is wrong.\n- \"The finding is overstated / already partly fixed\" is a valuable result. Report it plainly.\n\n## STEP 1 — the cheap confirmed sub-case (DO THIS ONE)\n`commands/prism-telemetry.md` describes functionality that `tools/prism-telemetry-aggregate.mjs` ALREADY FULLY IMPLEMENTS — the doc simply never cites the path, so the model may improvise instead of invoking the tool. Verify this is true by reading both files. If confirmed, edit `commands/prism-telemetry.md` to cite the exact script path and invocation. This is a documentation fix only — do NOT modify the tool.\nCheck whether the same trivially-fixable disconnect exists for any of the other six (a tool exists but the doc doesn't cite it). Fix those the same way — a path citation, nothing more.\n\n## STEP 2 — the class-level decision (ANALYSIS ONLY, DO NOT IMPLEMENT)\nFor the commands that genuinely have NO backing script, do NOT start writing tools. Produce an analysis for the owner:\n- For each: what it claims to do, what state it mutates (if any), and the blast radius if the model improvises it wrongly.\n- Rank by risk. Justify `prism-index` at or near the top given it writes `roster.json`.\n- For `prism-index` specifically: read `commands/prism-index.md`, determine the exact `roster.json` shape it is supposed to produce, and check whether `tools/` already has something that produces part of it (e.g. roster-lock helpers, reconcile logic). State how much would genuinely need building vs. wiring up what exists.\n- Recommend a class-level policy: should every state-mutating command REQUIRE a backing script? Should prose-only commands be marked as such in their own frontmatter so the model knows it is improvising?\n\n## Constraints\n- Use Edit/Write tools ONLY for edits. NOT Bash/PowerShell redirection — UTF-8 BOM corruption.\n- You may edit files under `commands/` ONLY. Do NOT edit anything under `hooks/` or `tools/` — other agents are working in that tree concurrently and you will collide.\n- Do NOT commit.\n- Do NOT write any new tool in this pass. Analysis then owner decision, then implementation later.\n\n## Reporting requirement\nA known PRISM defect means the report-back instruction does not reach agents dispatched this way, so I state it manually: **you MUST send me a full prose report when done.** Include: the verified per-command status table (with the corrected count if the filed 23/6 numbers are wrong), exactly which docs you edited and the citation text you added, the risk ranking with reasoning, the `prism-index` build-vs-wire assessment, and your class-level policy recommendation. Do not finish with a bare \"done\".";

try {
  // ══ FALSE POSITIVE 1 — RED before the fix, QUIET after ═════════════════════
  // verdicts-coverage (a CLI unit-test task) vs handoff-finder (locate the
  // latest handoff file). Pre-fix: shared=9, coefficient=0.360 -> FIRES.
  // Post-fix: background median 0.132 -> excess 0.228 < 0.30 -> quiet.
  {
    const sid = 'f36-fp1';
    seedLive(sid, LIVE_AT_FP1);
    const r = await run(dispatch(sid, 'verdicts-coverage', 'F30 test coverage for verdicts CLI', FRESH_FP1));
    const adv = advisoryOf(r);
    check('FP1: CLI-unit-test dispatch vs unrelated handoff task -> QUIET',
      r.exit === 0 && !adv, adv);
    check('FP1: handoff-finder absent from the COMPLETE logged hit set',
      !hitsOf(sid).includes('handoff-finder'), JSON.stringify(hitsOf(sid)));
  }

  // ══ FALSE POSITIVE 2 — the chair-self-delegation case ══════════════════════
  // Pre-fix: shared=48, coefficient=0.318 -> FIRES against team-lead.
  // Post-fix: background median 0.311 -> excess 0.007 -> quiet. This is the
  // clearest evidence of the root cause: the observed score was INDISTINGUISHABLE
  // from what this dispatch scored against every other live agent.
  {
    const sid = 'f36-fp2';
    seedLive(sid, LIVE_AT_FP2);
    const r = await run(dispatch(sid, 'general-purpose', 'Author D087 and fix 44', FRESH_FP2));
    const adv = advisoryOf(r);
    check('FP2: fresh dispatch vs a batch of 9 live agents -> QUIET',
      r.exit === 0 && !adv, adv);
    check('FP2: team-lead (the CHAIR) absent from the COMPLETE logged hit set',
      !hitsOf(sid).includes('team-lead'), JSON.stringify(hitsOf(sid)));
    check('FP2: NOTHING in the batch is advised (all scores were background)',
      hitsOf(sid).length === 0, JSON.stringify(hitsOf(sid)));
  }

  // ══ TRUE POSITIVE A — genuine duplicate against the SAME noisy background ═══
  // Re-dispatching the eperm-sweep brief while eperm-sweep is live must still
  // fire. Same 8-agent background as FP1, so this proves the fix suppresses
  // batch-wide noise WITHOUT suppressing real duplication.
  {
    const sid = 'f36-tp-eperm';
    seedLive(sid, LIVE_AT_FP1);
    const r = await run(dispatch(sid, 'eperm-sweep-dup', 'Fix 47 EPERM rename retry sweep', FRESH_TP_EPERM));
    const adv = advisoryOf(r);
    check('TP-A: re-dispatch of a live agent\'s own brief -> ADVISORY still fires',
      r.exit === 0 && /LIVE-WORK DEDUP/.test(adv) && /eperm-sweep/.test(adv), adv);
  }

  // ══ TRUE POSITIVE B — SHORT live brief vs LONG fresh brief ═════════════════
  // command-backing's ledger text is 600 chars against a 3790-char fresh
  // prompt. This asymmetric shape is precisely the one a Jaccard (union-
  // denominator) fix would have silently broken — measured at 0.181, below the
  // 0.30 bar — which is why the excess-over-background mechanism was chosen
  // over Jaccard. Guards that rejected alternative from creeping back in.
  {
    const sid = 'f36-tp-cmdback';
    seedLive(sid, LIVE_AT_FP1);
    const r = await run(dispatch(sid, 'command-backing-dup', 'Audit prose-only slash commands', FRESH_TP_CMDBACK));
    const adv = advisoryOf(r);
    check('TP-B: short live brief vs long duplicate fresh brief -> ADVISORY still fires',
      r.exit === 0 && /LIVE-WORK DEDUP/.test(adv) && /command-backing/.test(adv), adv);
  }

  // ══ DEGENERACY GUARD — a single live agent must not silence the guard ══════
  // A genuine duplicate with exactly ONE live peer MUST still fire. This was
  // the assertion that forced F36/F41 to keep a special small-sample branch:
  // with the background drawn from the live batch, one peer left nothing to
  // estimate a baseline from. Since the F41 corpus fix the background comes
  // from the PERSISTED ledger corpus instead, so this case is no longer
  // special — it fires from a measured background like every other case
  // (measured excess 0.774 against the corpus this test itself accumulates,
  // 0.842 against the real ~/.claude corpus). Keep it green: if it ever needs
  // a branch again, the corpus has stopped being reachable.
  {
    const sid = 'f36-degeneracy';
    seedLive(sid, { 'eperm-sweep': LIVE_AT_FP1['eperm-sweep'] }); // one agent only
    const r = await run(dispatch(sid, 'eperm-sweep-dup', 'Fix 47 EPERM rename retry sweep', FRESH_TP_EPERM));
    const adv = advisoryOf(r);
    check('degeneracy: 1 live agent + real duplicate -> still fires (corpus background, no branch)',
      r.exit === 0 && /LIVE-WORK DEDUP/.test(adv) && /eperm-sweep/.test(adv), adv);
  }

  // ══ F41 (task #58) — MIN_EXCESS must not be a NO-OP at a zero baseline ════
  // ORIGINALLY: when the live batch was too small to estimate from, baseline
  // was FORCED to 0, and with baseline===0 excess===coefficient identically,
  // so `excess >= MIN_EXCESS` was logically IMPLIED by `coefficient >=
  // MIN_COEFF` (both were 0.30) — a strict no-op, not merely a weakened guard.
  // SINCE THE CORPUS FIX: the baseline here is a MEASURED 0 (this fixture's
  // filler vocabulary genuinely resembles nothing in the corpus), not a
  // stand-in for "unknown". The measurement changed; the arithmetic did not,
  // so the fix is that MIN_EXCESS (0.35) now differs from MIN_COEFF (0.30) and
  // the conjunct still binds at a zero baseline. Measured excess 0.308 -> below
  // 0.35 -> quiet. This assertion is what stops the two constants being made
  // equal again. Real vocabulary (not
  // synthetic filler), the exact 8 tokens the census cited: already, cheap,
  // check, commands, description, descriptions, false, fork.
  //
  // Fixture: two live agents. 'dup-candidate' shares those 8 tokens with the
  // fresh dispatch at coefficient 8/26 = 0.3077 (measured via keywordsOf/
  // taskOverlap directly — see the fix's commit). 'filler-agent' shares NOTHING
  // with the fresh dispatch (0.0) — it exists only so kwScored.length===2,
  // giving 'dup-candidate' exactly ONE background document (filler's 0.0
  // score), still < MIN_BG_DOCS===2, so baseline stays 0 and the old
  // absolute-only behaviour is exactly what fires pre-fix.
  //
  // Pre-fix: coefficient 0.3077 >= MIN_COEFF(0.30) and excess(=coefficient)
  // >= MIN_EXCESS(0.30) -> FIRES on a borderline overlap with no comparison
  // basis, the same character of false-positive F36 exists to suppress
  // (FP1/FP2 measured 0.360/0.318) but F36's own mechanism cannot reach here.
  // Post-fix: must be QUIET (this is the RED assertion — fails until fixed).
  {
    const sid = 'f41-no-baseline';
    const DUP_LIVE_TEXT = 'already cheap check commands description descriptions false fork plumbing rotation ledger surface backoff variance texture gravel corridor thickness pipeline mosaic outline traction filament junction beacon lantern';
    const FILLER_LIVE_TEXT = 'lighthouse plankton estuary seaweed barnacle driftwood shipwreck anemone coral reef current tidepool starfish jellyfish';
    const FRESH_F41 = 'already cheap check commands description descriptions false fork orchard velocity cathedral spindle horizon meridian cascade thunder ribbon compass anchor tundra glacier canyon quarry marble granite thistle harvest paddock meadow bramble willow';
    seedLive(sid, { 'dup-candidate': [DUP_LIVE_TEXT], 'filler-agent': [FILLER_LIVE_TEXT] });
    const r = await run(dispatch(sid, 'fresh-worker', '', FRESH_F41));
    const adv = advisoryOf(r);
    check('F41: ~31% overlap at a MEASURED zero baseline -> QUIET (MIN_EXCESS still binds)',
      r.exit === 0 && !adv, adv);
    check('F41: dup-candidate absent from the COMPLETE logged hit set',
      !hitsOf(sid).includes('dup-candidate'), JSON.stringify(hitsOf(sid)));
  }
} finally {
  rmSync(HOME, { recursive: true, force: true });
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
