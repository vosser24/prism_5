#!/usr/bin/env node
// tests/v3/state/test-prism-force-token-paste-bypass.mjs
//
// RED test for F16 (HIGH — guard-rail bypass, co-test finding 2026-07-27).
//
// Bug: classifyPrompt() in hooks/lib/prism-opus-classifier.mjs computes the two
// user-override tokens with an UNANCHORED substring match:
//   :350  const forceGp  = str.includes('!gp-force:');
//   :353  const forceOpus = str.includes('!opus-force:');
// so the token matches ANYWHERE in the prompt. But the module's own documented
// decision chain (:34) says "`!opus-force:` PREFIX -> {force_opus:true}".
//
// The exploit: PRISM's own guard ERROR TEXT literally contains the instruction
// "prefix your user prompt with !opus-force:" (e.g. prism-parent-dispatch-guard
// .mjs:542, prism-mutation-guard.mjs:387). Pasting ANY PRISM guard/audit output
// into a PRISM session therefore sets force_opus:true on the turn sentinel — a
// full mutation-guard + dispatch-guard bypass triggered by pasted content, not
// by the user. This is exactly the D069 threat (force_opus is reserved for the
// USER's explicit prefix). CONFIRMED LIVE 2026-07-27: pasting a /prism-audit
// transcript set force_opus:true, source:force-opus on the sentinel.
//
// DESIRED post-fix behavior (these assertions FAIL on current code):
//   - mid-body / pasted  `!opus-force:` -> force_opus === false
//   - leading            `!opus-force:` -> force_opus === true  (must stay true)
//   - mid-body / pasted  `!gp-force:`   -> force_gp   === false
//   - leading            `!gp-force:`   -> force_gp   === true  (must stay true)
//   - leading token after benign whitespace/newline still counts as leading.
//
// This test exercises the exported classifyPrompt() entry point (the live
// sentinel-producing path). Run: node tests/v3/state/test-prism-force-token-paste-bypass.mjs
// Exit: 0 = all pass; 1 = any failure.

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLASSIFIER_LIB = join(__dirname, '..', '..', '..', 'hooks', 'lib', 'prism-opus-classifier.mjs');
const { classifyPrompt } = await import(pathToFileURL(CLASSIFIER_LIB).href);

// Temp cache dir so these probes never touch the user's real tier cache.
const cachePath = join(mkdtempSync(join(tmpdir(), 'prism-force-token-')), 'cache.json');

let pass = 0, total = 0;
function check(label, cond) {
  total++;
  if (cond) { pass++; process.stdout.write(`  ok  ${label}\n`); }
  else       { process.stdout.write(`  FAIL ${label}\n`); }
}

// ── F16 !opus-force: — pasted guard text must NOT grant force_opus ───────────
// Representative pasted PRISM guard error line. The token sits mid-body.
const PASTED_GUARD_TEXT =
  'here is the guard output I got:\n' +
  'Parent Write/Edit/Bash blocked. Override for this turn: prefix your user ' +
  'prompt with !opus-force:. Why did this happen and how do I proceed safely?';

{
  const r = await classifyPrompt({ prompt: PASTED_GUARD_TEXT, skipCache: true, cachePath });
  check('F16-a: pasted/mid-body !opus-force: does NOT set force_opus (guard-rail bypass closed)',
    r.force_opus === false);
  check('F16-a2: pasted/mid-body !opus-force: does NOT emit source:force-opus',
    r.source !== 'force-opus');
}

// ── F16 leading !opus-force: — the LEGITIMATE user override must survive ─────
{
  const r = await classifyPrompt({ prompt: '!opus-force: do the thing', skipCache: true, cachePath });
  check('F16-b: leading !opus-force: still sets force_opus (user override preserved)',
    r.force_opus === true && r.source === 'force-opus');
}
{
  // Leading token after benign whitespace/newline still counts as leading
  // (fix should trimStart before the prefix test).
  const r = await classifyPrompt({ prompt: '  \n!opus-force: do the thing', skipCache: true, cachePath });
  check('F16-b2: !opus-force: after leading whitespace still sets force_opus',
    r.force_opus === true && r.source === 'force-opus');
}

// ── F16 !gp-force: — same unanchored-match defect on the orthogonal token ────
const PASTED_GP_GUARD_TEXT =
  'the specialist-routing-guard said:\n' +
  'Override: prefix the user prompt with !gp-force: (or set PRISM_SPECIALIST_GUARD' +
  '=off). What is the right general-purpose worker to use for this cleanup task?';

{
  const r = await classifyPrompt({ prompt: PASTED_GP_GUARD_TEXT, skipCache: true, cachePath });
  check('F16-c: pasted/mid-body !gp-force: does NOT set force_gp (specialist-guard bypass closed)',
    r.force_gp === false);
}

// ── F16 leading !gp-force: — legitimate override must survive ────────────────
{
  const r = await classifyPrompt({ prompt: '!gp-force: use the general-purpose worker for this', skipCache: true, cachePath });
  check('F16-d: leading !gp-force: still sets force_gp (user override preserved)',
    r.force_gp === true);
}

process.stdout.write(`\n${pass} passed, ${total - pass} failed (${total} total)\n`);
process.exit(pass === total ? 0 : 1);
