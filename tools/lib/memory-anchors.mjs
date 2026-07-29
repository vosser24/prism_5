// tools/lib/memory-anchors.mjs — shared anchor-scoped upsert for MEMORY.md
// (C1, recall-hardening spec — docs/prism/plans/2026-07-13-IMPL-SPEC-recall-hardening.md).
//
// Factored OUT of tools/prism-clean.mjs's inline appendUnderAnchor() so both
// prism-clean.mjs (manual /prism-clean append-decision / append-lesson /
// append-summary) and tools/lib/memory-heal.mjs (automatic SessionStart heal,
// C2) share ONE implementation of "find an anchor comment, manage the bullet
// list directly under it, keep only the last N".
//
// Behavior is byte-identical to the original appendUnderAnchor for the three
// existing call sites (decision / lesson / summary anchors), PLUS one
// addition required by C2: idempotency. The original was strictly
// append-only (calling it twice with the same line produced two identical
// bullets, only cleaned up once the 10-item window scrolled past them). The
// shared version de-dupes an exact-match line before re-adding it, so a
// heal pass that runs every SessionStart never accretes duplicate pointers.
//
// Exports:
//   upsertUnderAnchor(body, anchorMarker, line, {keep = 10}) -> newBody
//     - Normalizes CRLF -> LF (Windows-saved files don't produce mixed
//       line-endings in the output).
//     - Locates the anchorMarker line (an HTML comment, matched by trimmed
//       string equality) in `body`.
//     - Throws an Error with `.code === 'ANCHOR_NOT_FOUND'` if the anchor is
//       missing — callers decide how to surface that (prism-clean.mjs exits
//       7; memory-heal.mjs fails open).
//     - The anchor's "section" runs from the line after the anchor to the
//       next `## ` heading (or EOF). Within that section, every line
//       starting with `- ` is treated as a managed bullet entry; blank
//       lines directly under the anchor (before the first bullet) are
//       preserved; anything else is dropped (matches original behavior —
//       these sections only ever hold blank lines + bullets).
//     - De-dupes any existing bullet exactly equal to `line`, appends
//       `line`, then trims to the last `keep` entries.
//     - Rebuilds the section with exactly one trailing blank line before
//       the next `## ` heading / EOF.
//     - F45/[[D083]]: the trim is no longer silent. Entries that fall out of
//       the `keep` window are named in a `memory_anchor_trim` telemetry
//       record. This matters because the two callers pass DIFFERENT `keep`
//       values for the SAME anchors (memory-heal.mjs 20 vs prism-clean.mjs
//       10), so the effective window depends on which path wrote last, and
//       a caller with the smaller window silently discards up to 10 entries
//       the other path deliberately retained. Repairing the delivery layer
//       already present rather than adding a new channel, per [[D083]].

import {logAdvisory} from '../../hooks/lib/prism-advisory-log.mjs';

export function upsertUnderAnchor(body, anchorMarker, line, {keep = 10} = {}) {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const anchorIdx = lines.findIndex((l) => l.trim() === anchorMarker.trim());
  if (anchorIdx < 0) {
    const err = new Error(`upsertUnderAnchor: anchor not found in body: ${anchorMarker}`);
    err.code = 'ANCHOR_NOT_FOUND';
    throw err;
  }

  let endIdx = lines.length;
  for (let i = anchorIdx + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) { endIdx = i; break; }
  }

  const sectionBody = lines.slice(anchorIdx + 1, endIdx);
  const nonPointer = []; // leading blank lines directly under the anchor
  let pointers = [];
  let sawPointer = false;
  for (const l of sectionBody) {
    if (/^- /.test(l)) {
      pointers.push(l);
      sawPointer = true;
    } else if (!sawPointer) {
      nonPointer.push(l); // preserve leading blanks
    }
    // Any non-bullet line AFTER bullets begin is dropped (trailing
    // whitespace etc.) — same as the original appendUnderAnchor.
  }

  // Idempotent: drop any existing exact duplicate before re-adding it (this
  // also refreshes its recency position at the end of the window).
  pointers = pointers.filter((p) => p !== line);
  pointers.push(line);
  const kept = pointers.slice(-keep);
  // The drop, named. Fail-open telemetry only — logAdvisory swallows its own
  // errors, so this cannot break the write it is reporting on.
  if (pointers.length > kept.length) {
    logAdvisory({
      event: 'memory_anchor_trim',
      anchor: anchorMarker.slice(0, 80),
      keep,
      before: pointers.length,
      after: kept.length,
      dropped: pointers.slice(0, pointers.length - kept.length),
    });
  }

  const rebuilt = [...nonPointer, ...kept, ''];
  const newLines = [
    ...lines.slice(0, anchorIdx + 1),
    ...rebuilt,
    ...lines.slice(endIdx),
  ];

  // #85: the `## <name> (last N, pointer-only)` heading above this anchor
  // used to hard-code a literal N that only ever matched WHICHEVER caller's
  // `keep` last wrote it — prism-clean.mjs's own POINTER_KEEP (10) and
  // memory-heal.mjs's SessionStart POINTER_KEEP (20, see the file-header
  // comment above) both render through this same function, so the label and
  // the actual rendered bullet count silently diverged (heading said "last
  // 10", SessionStart-healed file had 20). Fix at the single source both
  // callers share: rewrite the heading's count to `kept.length` — the ACTUAL
  // number of bullets just rendered — every time this function runs, so the
  // label can never name a different number than what's on the page, for
  // any `keep` value either caller passes. Scoped to headings that already
  // carry the "(last N, ...)" parenthetical (decisions/lessons only) — other
  // `## ` headings (Session log, Standing rules, ...) don't match and are
  // left untouched.
  let headingIdx = -1;
  for (let i = anchorIdx - 1; i >= 0; i--) {
    if (/^## /.test(newLines[i])) { headingIdx = i; break; }
  }
  if (headingIdx >= 0 && /\(last \d+,/.test(newLines[headingIdx])) {
    newLines[headingIdx] = newLines[headingIdx].replace(/\(last \d+,/, `(last ${kept.length},`);
  }

  return newLines.join('\n');
}
