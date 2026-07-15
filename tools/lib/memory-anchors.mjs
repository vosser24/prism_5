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

  const rebuilt = [...nonPointer, ...kept, ''];
  const newLines = [
    ...lines.slice(0, anchorIdx + 1),
    ...rebuilt,
    ...lines.slice(endIdx),
  ];
  return newLines.join('\n');
}
