#!/usr/bin/env node
// force_opus self-grant policy — mechanical, hermetic test.
//
// Owner policy: the conversation model MAY self-correct `tier` and
// `summon_panel` via the v3.2.0 self-override protocol, but must NOT
// self-set `force_opus:true` — that flag is the full dispatch-guard bypass
// (equivalent of the user's `!opus-force:` prefix) and is reserved for the
// USER. This is a TEXT/guidance-only change to the directive string built by
// buildOverrideDirective() in hooks/prism-prompt-tier-router.mjs — no new
// gate, no control-flow change.
//
// buildOverrideDirective is a pure function (no I/O) and is already exported
// for unit testing, so this test imports it directly rather than spawning
// the router subprocess (unlike the sibling
// tests/v3/state/test-tier-override-telemetry.mjs, which exercises sentinel/
// routing-log side effects that DO require a subprocess).
//
// Run: node tests/v3/state/test-prism-override-force-opus-policy.mjs

import {buildOverrideDirective} from '../../../hooks/prism-prompt-tier-router.mjs';

let pass = 0, fail = 0;
function ok(name) { pass++; process.stdout.write(`  PASS ${name}\n`); }
function bad(name, msg) { fail++; process.stdout.write(`  FAIL ${name}\n        ${msg}\n`); }
function check(name, fn) {
  try { fn(); ok(name); } catch (e) { bad(name, e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const directive = buildOverrideDirective('sonnet', false, 'test-session-1');

check('(a) directive contains the new force_opus prohibition + tells the model to ask the user', () => {
  assert(/may not self-set\s*`?force_opus\b.{0,12}/i.test(directive),
    `expected /may NOT self-set .{0,12}force_opus/i to match, got:\n${directive}`);
  assert(/ask the user/i.test(directive),
    `expected /ask the user/i to match, got:\n${directive}`);
});

check('(b) directive still contains legitimate tier-correction guidance', () => {
  assert(/tier/i.test(directive), 'expected directive to still mention tier');
  // The sentinel-write instruction (Read-then-Write/Edit corrected fields).
  assert(/Write or Edit it with corrected fields/i.test(directive),
    `expected sentinel-write instruction to survive, got:\n${directive}`);
  assert(/summon_panel/i.test(directive), 'expected summon_panel to still be mentioned as correctable');
});

check('(c) directive does NOT instruct the model to set force_opus affirmatively', () => {
  // Guard against a regression that adds an affirmative instruction such as
  // 'set force_opus:true' or 'write force_opus:true' anywhere in the string.
  assert(!/\b(set|write)\s+force_opus["`']?\s*[:=]\s*true/i.test(directive),
    `directive must not affirmatively instruct setting force_opus:true, got:\n${directive}`);
});

check('directive is stable across different tier/sessionId inputs (pure function, no I/O)', () => {
  const d2 = buildOverrideDirective('opus', true, 'another-session');
  assert(/may not self-set\s*`?force_opus\b.{0,12}/i.test(d2), 'prohibition must appear regardless of tier/summonPanel inputs');
  assert(d2.includes('another-session'), 'sentinel path must interpolate the given sessionId');
});

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
