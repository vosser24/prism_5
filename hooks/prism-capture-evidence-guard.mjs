#!/usr/bin/env node
// PRISM Capture-Evidence Guard (v6.2.1)
//
// PreToolUse guard on Write/Edit/MultiEdit. DENIES a write to a
// captured-knowledge path (docs/prism/adjudications/**, docs/prism/lessons/**,
// tasks/lessons-*.md) when the resulting content asserts a factual
// verification-style claim ("this works", "root cause is", "confirmed",
// "fixed", ...) but carries no `**Verified:**` evidence field anywhere in
// the file.
//
// WHY (see .claude/rules/capture-conventions.md, "Verify ground truth before
// you capture 'it works'"): that rule already existed in prose and was still
// violated — a session captured an adjudication diagnosing a bug it never
// reproduced, and the fiction got locked into the knowledge base. Doctrine,
// unenforced, is decoration. This guard makes the doctrine machine-checked.
//
// DESIGN CONSTRAINTS (deliberately narrow — a blocking guard that fires on
// legitimate writes gets disabled and burns the whole enforcement channel):
//   - Scope-gated to captured-knowledge paths ONLY. Never fires on ordinary
//     source/docs.
//   - Trigger-gated: only fires when the content actually asserts a
//     verification-style claim. A file with no such claim (e.g. a pure
//     "Deliberately NOT doing" list, a process doc) is never touched.
//   - REQUIRED-FIELD check, not semantic judgment of whether the evidence is
//     convincing. We check the `**Verified:**` field EXISTS — we do not
//     grade its contents. An honest "NOT REPRODUCED — unconfirmed" disclaimer
//     satisfies the gate; the goal is to make unverified claims VISIBLE, not
//     to forbid them.
//   - Edit/MultiEdit reconstruct the RESULTING full-file content (read
//     current file from disk, apply the proposed edit(s)) before scanning —
//     so an edit that only touches an unrelated section of an already-
//     evidenced file is not false-flagged just because the diff itself
//     doesn't contain the field.
//
// Modes (PRISM_CAPTURE_EVIDENCE_GATE env var):
//   hard (default, unset):  emit deny + exit 2 (tool blocked)
//   soft:                   emit additionalContext nudge + exit 0 (pass-through)
//   off:                    silent pass-through, exit 0
//
// Dual-mode like the other consolidated guards: run(input) returns
// {exit, stdout, stderr} for the in-process PreToolUse dispatcher; the
// standalone shim at the bottom preserves stdin->stdout/exit wire behavior.

import {readFileSync, existsSync, appendFileSync, mkdirSync} from 'fs';
import {basename, join, dirname} from 'path';
import {prismHome} from './lib/prism-home.mjs';

// Event-keyed routing-log record (census visibility). A default-HARD blocking
// guard with no audit trail cannot be censused — emit on BOTH the deny and the
// allow path of every IN-SCOPE evaluation (out-of-scope writes stay silent so
// this never floods the log). Additive only; never affects control flow.
function appendLog(obj) {
  try {
    const p = join(prismHome(), '.claude', '.prism-routing.jsonl');
    mkdirSync(dirname(p), {recursive: true});
    appendFileSync(p, JSON.stringify(obj) + '\n');
  } catch { /* fail-open */ }
}

// Read fresh on every call (not cached at module load) so this stays
// testable in-process (import once, toggle env per-case) with no change to
// production behavior — the dispatcher spawns a fresh process per hook
// invocation anyway, so a per-call read is behavior-neutral there.
function getMode() {
  const v = process.env.PRISM_CAPTURE_EVIDENCE_GATE;
  return (v !== undefined ? v : 'hard').toLowerCase();
}

// Captured-knowledge paths — see .claude/rules/capture-conventions.md buckets.
// Matched as a substring against the normalized (forward-slash) file path, so
// this works regardless of repo root / absolute-vs-relative path shape.
const IN_SCOPE_RE = [
  /(^|\/)docs\/prism\/adjudications\//i,
  /(^|\/)docs\/prism\/lessons\//i,
  /(^|\/)tasks\/lessons-[^/]+\.md$/i,
  /(^|\/)docs\/prism\/deviations\//i,
];

// Verification-style factual-claim triggers. Deliberately keyword-based
// (not semantic) — narrow enough that ordinary design-rationale prose
// ("this approach works well architecturally as a boundary") in an
// unrelated file never reaches this check (path-scope already excludes it),
// and inside captured-knowledge files this vocabulary is exactly the
// "it works" / "it's the root cause" claims the rule is about.
export const CLAIM_TRIGGER_RE = /\b(works|is fixed|are fixed|was fixed|resolves?|resolved|is broken|are broken|was broken|root[\s-]*cause|caused by|confirms?|confirmed|reproduces?|reproduced|no longer (fails|occurs)|now passes|passes now|is now working|bug is|tests? pass(es|ed)?|(all |the )?tests? (are |were )?(green|passing)|suite (is )?green|ha(?:s|ve|d) no [`"'*_]{0,2}(?!side[\s-]?effects?\b|effect\b|impact\b|bearing\b)(?![A-Z]\b)[a-z_][\w-]*|(?<!\b[A-Z] )(is|are|was|were) empty(?! by (?:design|default))|(?<!\b[A-Z] )(is|are|was|were) missing)\b/i;

// The required evidence field. Presence-only check — content is NOT graded.
const EVIDENCE_FIELD_RE = /\*\*Verified:\*\*/i;

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/');
}

function isInScope(filePath) {
  const norm = normalizePath(filePath);
  return IN_SCOPE_RE.some((re) => re.test(norm));
}

// Apply a single Edit-style {old_string, new_string, replace_all} to a
// string. Best-effort: if old_string isn't found, the string is returned
// unchanged (matches don't materialize content that was never there).
function applyEdit(content, oldStr, newStr, replaceAll) {
  if (!oldStr) return content;
  if (replaceAll) return content.split(oldStr).join(newStr);
  const idx = content.indexOf(oldStr);
  if (idx === -1) return content;
  return content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
}

// Reconstruct the resulting full-file content for the proposed write, so
// claim/evidence scanning sees the whole file, not just a fragment of a diff.
export function resultingContent(toolName, toolInput) {
  const ti = toolInput || {};
  const filePath = ti.file_path || ti.path || '';

  if (toolName === 'Write') {
    return typeof ti.content === 'string' ? ti.content : '';
  }

  let current = '';
  try {
    if (filePath && existsSync(filePath)) current = readFileSync(filePath, 'utf-8');
  } catch { /* unreadable — fall back to '' and reason about the diff alone */ }

  if (toolName === 'Edit') {
    if (!current) return String(ti.new_string || '');
    return applyEdit(current, ti.old_string || '', ti.new_string || '', !!ti.replace_all);
  }

  if (toolName === 'MultiEdit') {
    const edits = Array.isArray(ti.edits) ? ti.edits : [];
    if (!current) return edits.map((e) => e.new_string || '').join('\n');
    let out = current;
    for (const e of edits) out = applyEdit(out, e.old_string || '', e.new_string || '', !!e.replace_all);
    return out;
  }

  return '';
}

// v6.6.1 FIX-4c-follow-up: the genuinely-added region of a single edit pair.
// A raw new_string is NOT "what was added" — it commonly carries a verbatim
// anchor (the old_string content reproduced so the edit can locate itself),
// and when that anchor happens to include the file's historical
// **Verified:** line, treating the whole new_string as "added" let that
// carried-over evidence field satisfy the ratchet's "added text has no
// Verified field" check even though the truly-new appended material had
// none of its own (the UAT-discovered bypass). Strip the longest common
// LEADING and TRAILING *lines* that new_string shares with old_string — what
// remains is the actual delta the edit introduced. This must diff at LINE
// granularity, not character granularity: a char-level strip absorbs shared
// characters like "#" across two DIFFERENT heading lines (e.g. inserting
// "## New finding" immediately above an existing "### Subsection" lets the
// char-level stripper eat the leading "##" as "common prefix" and trailing
// "# Subsection" as "common suffix", leaving a delta with no leading "#" at
// all — NEW_HEADING_RE then misses a brand-new heading entirely). Diffing
// whole lines keeps every delta line-aligned so the heading regex still
// sees a complete line.
function addedRegion(oldStr, newStr) {
  const oLines = String(oldStr || '').split('\n');
  const nLines = String(newStr || '').split('\n');
  let prefix = 0;
  const maxPrefix = Math.min(oLines.length, nLines.length);
  while (prefix < maxPrefix && oLines[prefix] === nLines[prefix]) prefix++;
  let suffix = 0;
  const maxSuffix = Math.min(oLines.length, nLines.length) - prefix;
  while (suffix < maxSuffix && oLines[oLines.length - 1 - suffix] === nLines[nLines.length - 1 - suffix]) suffix++;
  return nLines.slice(prefix, nLines.length - suffix).join('\n');
}

// v6.6.0 FIX-4c: concatenated ADDED material for Edit/MultiEdit — used ONLY
// by the per-new-entry ratchet in run() below. Write has no "added vs
// existing" distinction (the whole file IS new), so this is never called
// for Write.
function addedMaterial(toolName, toolInput) {
  const ti = toolInput || {};
  if (toolName === 'Edit') return addedRegion(ti.old_string, ti.new_string);
  if (toolName === 'MultiEdit') {
    const edits = Array.isArray(ti.edits) ? ti.edits : [];
    return edits.map((e) => addedRegion(e.old_string, e.new_string)).join('\n');
  }
  return '';
}

// A markdown heading in the added text signals a NEW entry (not a tweak
// inside an existing one) — the ratchet gate below only fires on this class.
const NEW_HEADING_RE = /^#{1,6}\s/m;

// `scoped` distinguishes the two conditions this gate can fire on — they are
// NOT the same claim and must not share wording (see the D060 owner-report:
// the old single-template message asserted "the file carries no **Verified:**
// field" even when the file plainly had one, just not inside the newly-added
// entry — an author who greps the file, finds the field, and gets denied
// again anyway burns retries decoding a message that lied about which scope
// was checked):
//   - scoped=false: EVIDENCE_FIELD_RE found no **Verified:** ANYWHERE in the
//     resulting file. "the file carries no **Verified:** field" is accurate.
//   - scoped=true: the per-entry ratchet fired — a **Verified:** field DOES
//     exist elsewhere in the file (that's why the whole-file branch was
//     entered at all), but the newly-added block introduces its own new
//     heading + claim with no **Verified:** field of its own. The message
//     must name that scope explicitly, not claim absence.
function denyMessage(filePath, matched, scoped) {
  const claimLine = scoped
    ? [
        `PRISM CAPTURE-EVIDENCE GATE: this write to ${filePath} adds a new entry`,
        `(new heading) that asserts a factual claim (matched: "${matched}"), but`,
        `the ADDED block carries no **Verified:** field of its own. A`,
        `**Verified:** field elsewhere in the file (e.g. the header) attests to`,
        `THAT original capture — it does not cover a new section appended later.`,
      ]
    : [
        `PRISM CAPTURE-EVIDENCE GATE: this write to ${filePath} asserts a factual`,
        `claim (matched: "${matched}") but the file carries no **Verified:** field.`,
      ];
  return [
    ...claimLine,
    ``,
    `Per .claude/rules/capture-conventions.md ("Verify ground truth before you`,
    `capture 'it works'"): confirm ground truth before capturing a claim — the`,
    `files changed, the claimed paths exist, the relevant tests pass — then`,
    `record HOW you checked. Add a line ${scoped ? 'to the new block' : 'to the header block'}, e.g.:`,
    `  **Verified:** <command> -> <real output>`,
    `If you did NOT check it, say so — that is a valid, honest capture:`,
    `  **Verified:** NOT REPRODUCED -- inherited claim, unconfirmed`,
    ``,
    `Fixes:`,
    `  1. Add a **Verified:** field (real evidence OR an explicit disclaimer)${scoped ? ' to the new entry' : ''} and retry.`,
    `  2. Disable this gate for the session: set PRISM_CAPTURE_EVIDENCE_GATE=off.`,
  ].join('\n');
}

export function run(input) {
  let out = '';
  const write = (s) => { out += s; };
  const done = (code) => ({exit: code, stdout: out, stderr: ''});

  const toolName = input.tool_name || '';
  if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'MultiEdit') return done(0);
  const mode = getMode();
  if (mode === 'off') return done(0);

  const ti = input.tool_input || {};
  const filePath = ti.file_path || ti.path || '<unknown>';
  if (!isInScope(filePath)) return done(0);

  const content = resultingContent(toolName, ti);
  const logBase = {
    event: 'capture_evidence_guard',
    ts: new Date().toISOString(),
    session_id: input.session_id || 'anon',
    tool: toolName,
    file: normalizePath(filePath),
    mode,
  };
  const claimMatch = CLAIM_TRIGGER_RE.exec(content);
  if (!claimMatch) { // no factual claim asserted — nothing to gate
    appendLog({...logBase, blocked: false, outcome: 'no-claim'});
    return done(0);
  }

  // v6.6.0 FIX-4c: close the per-file ratchet for NEW entries. One historical
  // **Verified:** field ANYWHERE in an append-only file previously immunized
  // every future unverified entry (EVIDENCE_FIELD_RE.test(content) scans the
  // whole resulting file). For Edit/MultiEdit, ALSO scan the added material
  // alone (the concatenated new_strings): if it introduces a NEW markdown
  // heading (a new entry, not a tweak inside an existing one) that asserts a
  // claim but carries no evidence field of its own, the whole-file pass does
  // NOT satisfy the gate. Write is unaffected — there is no "added vs
  // existing" distinction on a fresh Write (whole-file scan is already
  // correct there).
  let ratchetClaim = null;
  if (EVIDENCE_FIELD_RE.test(content)) {
    if (toolName === 'Edit' || toolName === 'MultiEdit') {
      const added = addedMaterial(toolName, ti);
      const addedClaim = CLAIM_TRIGGER_RE.exec(added);
      if (addedClaim && NEW_HEADING_RE.test(added) && !EVIDENCE_FIELD_RE.test(added)) {
        ratchetClaim = addedClaim[0];
      }
    }
    if (!ratchetClaim) { // evidence field present, no new-entry ratchet violation — satisfied
      appendLog({...logBase, blocked: false, outcome: 'evidence-present'});
      return done(0);
    }
  }

  const matchedClaim = ratchetClaim || claimMatch[0];
  const notice = denyMessage(filePath, matchedClaim, !!ratchetClaim);
  const ratchetField = ratchetClaim ? {ratchet: 'per-entry'} : {};

  if (mode === 'soft') {
    appendLog({...logBase, blocked: false, outcome: 'soft-nudge', claim: matchedClaim, ...ratchetField});
    write(JSON.stringify({
      hookSpecificOutput: {hookEventName: 'PreToolUse', additionalContext: notice},
    }));
    return done(0);
  }

  // hard (default)
  appendLog({...logBase, blocked: true, outcome: 'deny', claim: matchedClaim, ...ratchetField});
  write(JSON.stringify({
    hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: notice},
  }));
  return done(2);
}

// Guard: only run as a hook when invoked directly, NOT when imported by tests.
const invokedDirectly = process.argv[1] && basename(process.argv[1]) === 'prism-capture-evidence-guard.mjs';
if (invokedDirectly) {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf-8')); } catch { process.exit(0); }
  const r = run(input);
  if (r.stdout) process.stdout.write(r.stdout);
  process.exit(r.exit || 0);
}
