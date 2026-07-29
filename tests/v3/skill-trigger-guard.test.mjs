#!/usr/bin/env node
// Tests for hooks/prism-skill-trigger-guard.mjs - the 2026-07-14 revival fix
// (see docs/prism/2026-07-14-advisory-precision.md).
//
// Proves: (a) the 11 curated patterns in the REAL, shipped
// skill-triggers.md now actually load and match their own canonical
// examples (they previously loaded ZERO of them - every row's regex
// alternation was shredded by a naive markdown-table split('|'), throwing
// on new RegExp(), silently caught, guard permanently dead since v3.1.0);
// (b) a genuinely malformed pattern in the trigger table now fails LOUDLY
// (stderr warning + a skill_trigger_parse_error routing-log event) instead
// of vanishing into a silent catch, while unrelated valid rows in the same
// file still load.
//
// Hermetic: each scenario runs the REAL hook file as a child process
// (its own documented CLI entry point - reads a JSON payload on stdin,
// same as production) against an isolated temp HOME, so module-level
// caching (H, TRIGGERS_PATH, _triggersCache are all captured/populated at
// first use in-process) never leaks between scenarios.
//
// Run: node tests/v3/skill-trigger-guard.test.mjs

import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', '..', 'hooks', 'prism-skill-trigger-guard.mjs');

let pass = 0, fail = 0;
function ok(name) { pass++; console.log(`PASS  ${name}`); }
function bad(name, msg) { fail++; console.log(`FAIL  ${name}\n        ${msg}`); }
function check(name, cond, msg) { if (cond) ok(name); else bad(name, msg || 'condition false'); }

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'prism-skill-trigger-'));
}

function writeTriggersFile(home, content) {
  const refDir = join(home, '.claude', 'skills', 'prism-plan', 'references');
  mkdirSync(refDir, {recursive: true});
  writeFileSync(join(refDir, 'skill-triggers.md'), content);
}

function invokeHook(home, prompt, sessionId) {
  const payload = JSON.stringify({session_id: sessionId || 's', user_prompt: prompt});
  const res = spawnSync(process.execPath, [HOOK], {
    input: payload,
    env: {...process.env, HOME: home, USERPROFILE: home},
    encoding: 'utf-8',
  });
  return res; // {stdout, stderr, status}
}

function readRoutingLog(home) {
  const p = join(home, '.claude', '.prism-routing.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

let homeA, homeB;
try {
  // --- Scenario A: the REAL, shipped skill-triggers.md ---
  // Copied verbatim (not re-typed) so this test tracks the live curated
  // table rather than a hand-maintained duplicate that could drift from it.
  homeA = makeHome();
  const realTriggersPath = join(__dirname, '..', '..', 'skills', 'prism-plan', 'references', 'skill-triggers.md');
  const realTriggersContent = readFileSync(realTriggersPath, 'utf-8');
  writeTriggersFile(homeA, realTriggersContent);

  // One representative prompt per curated pattern (11 rows as of this
  // writing - see the file's own table for the current count).
  const casesA = [
    {prompt: 'check the accessibility of this design system', skill: 'ui-ux-pro-max'},
    {prompt: 'lets architect a plan for this', skill: 'blueprint-prompt'},
    {prompt: 'run a panel review of this decision', skill: 'prism-chat'},
    {prompt: 'improve our seo and page speed', skill: 'greek-ecommerce-seo-specialist'},
    {prompt: 'check my notebooklm notes', skill: 'notebooklm'},
    {prompt: 'set up a workflow for this', skill: 'workflow-orchestration'},
    {prompt: 'write a new hook for claude code', skill: 'claude-code-expert'},
    {prompt: 'run a security review on this diff', skill: 'security-review'},
    {prompt: 'simplify this code', skill: 'simplify'},
    {prompt: 'please review this pull request', skill: 'review'},
    {prompt: 'refresh roster now', skill: 'prism-discover'},
  ];

  for (const {prompt, skill} of casesA) {
    const res = invokeHook(homeA, prompt, 'scenario-a');
    check(`real table: "${prompt}" fires <${skill}>`,
      res.status === 0 && res.stdout.includes(`<${skill}>`),
      `expected stdout to mention <${skill}>, got status=${res.status} stdout=${JSON.stringify(res.stdout)} stderr=${JSON.stringify(res.stderr)}`);
  }

  // No parse errors should have been logged for the real, well-formed table.
  {
    const logLines = readRoutingLog(homeA);
    const parseErrors = logLines.filter(l => l.event === 'skill_trigger_parse_error');
    check('real table: zero parse errors logged (all 11 curated rows load cleanly)',
      parseErrors.length === 0,
      `expected 0 parse errors, got ${JSON.stringify(parseErrors)}`);
    const advisories = logLines.filter(l => l.event === 'skill_trigger_guard' && l.action === 'advisory');
    check('real table: advisory events are logged to the routing log',
      advisories.length === casesA.length,
      `expected ${casesA.length} advisory log entries, got ${advisories.length}`);
  }

  // --- Scenario B: a malformed trigger table ---
  // One genuinely invalid regex (unbalanced paren) alongside one valid row,
  // to prove (1) the malformed row fails LOUDLY (stderr + routing-log
  // event) instead of silently, and (2) the failure is per-row, not
  // whole-file - the valid row alongside it still loads and fires.
  homeB = makeHome();
  // NOTE: the marker word and skill-name tokens below deliberately avoid the
  // substrings "pattern" and "skill" — loadTriggers()'s header-row detector
  // is `/pattern/i.test(cells[0]) && /skill/i.test(cells[1])`, and an
  // earlier draft of this test used "goodpatternxyz" / "good-skill-xyz",
  // which the detector legitimately (if unluckily) mistook for a header row
  // and skipped. That was a test-data collision, not a hook bug — real
  // skill-triggers.md rows don't literally contain the word "pattern" in
  // their regex source, so this doesn't affect production.
  const malformedTable = [
    '| Pattern (case-insensitive regex) | Required skill | Severity |',
    '|---|---|---|',
    '| `\\b(goodmarkerzzz)\\b` | good-widget-zzz | nudge |',
    '| `\\b(unclosed` | broken-widget-zzz | nudge |',
    '',
  ].join('\n');
  writeTriggersFile(homeB, malformedTable);

  const resGood = invokeHook(homeB, 'this mentions goodmarkerzzz here', 'scenario-b-good');
  check('malformed table: the VALID sibling row still loads and fires (per-row failure, not whole-file)',
    resGood.status === 0 && resGood.stdout.includes('<good-widget-zzz>'),
    `expected <good-widget-zzz> to fire, got status=${resGood.status} stdout=${JSON.stringify(resGood.stdout)} stderr=${JSON.stringify(resGood.stderr)}`);

  const resTrigger = invokeHook(homeB, 'trigger the loader', 'scenario-b-load');
  check('malformed table: loading it fails LOUDLY on stderr (not a silent catch)',
    /malformed pattern/i.test(resTrigger.stderr),
    `expected a stderr warning mentioning "malformed pattern", got stderr=${JSON.stringify(resTrigger.stderr)}`);

  {
    const logLines = readRoutingLog(homeB);
    const parseErrors = logLines.filter(l => l.event === 'skill_trigger_parse_error');
    check('malformed table: a skill_trigger_parse_error event is logged to the routing log',
      parseErrors.length >= 1 && parseErrors.some(e => e.skill === 'broken-widget-zzz'),
      `expected a skill_trigger_parse_error entry for broken-widget-zzz, got ${JSON.stringify(logLines)}`);
  }

  // Contract: the hook must still exit 0 even when a row is malformed -
  // advisory hooks never block.
  check('malformed table: hook still exits 0 (advisory contract - never blocks)',
    resTrigger.status === 0,
    `expected exit 0, got ${resTrigger.status}`);
} finally {
  if (homeA) { try { rmSync(homeA, {recursive: true, force: true}); } catch {} }
  if (homeB) { try { rmSync(homeB, {recursive: true, force: true}); } catch {} }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
