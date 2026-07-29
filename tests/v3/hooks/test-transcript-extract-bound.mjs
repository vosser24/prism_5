#!/usr/bin/env node
// tests/v3/hooks/test-transcript-extract-bound.mjs
//
// F7 Phase 3 FOLLOW-UP — the assertion the mock-path latch test was MISSING.
//
// The live smoke proved a real defect: hooks/prism-phase-0d-oob.mjs fed 600 RAW
// JSONL lines (~1.2 MB on a real session, 2.6 MB on a pathological one) into
// `claude -p`, which replied "Prompt is too long", exit 1 → severity:"ERROR" →
// surfaced by SessionStart (cry-wolf). The mock-verdict latch test never
// exercised REAL prompt size (PRISM_PHASE_0D_MOCK_VERDICT short-circuits before
// the spawn), so it could not have caught this.
//
// This test builds the reviewer transcript payload from a HUGE synthetic
// transcript fixture (>1 MB of JSONL) exactly the way the hook does
// (extractDeliberation on the raw scan window) and asserts:
//   • the assembled transcript portion is < the byte cap (overflow impossible)
//   • it STILL contains the most-recent assistant deliberation text
//   • it DROPS tool_use / tool_result / thinking / system-reminder noise
//   • fail-open: a total parse failure still returns a byte-capped payload
//   • the test/simple {role:'assistant',text} shape also extracts
//
// Dep-free. Run: node tests/v3/hooks/test-transcript-extract-bound.mjs

import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const lib = await import(pathToFileURL(join(repoRoot, 'hooks', 'lib', 'prism-transcript-extract.mjs')).href);
const {extractDeliberation, capBytesTail, resolveMaxBytes, extractAssistantTurns,
       DEFAULT_MAX_INPUT_BYTES, DEFAULT_MAX_TURNS} = lib;

let pass = 0, fail = 0;
function check(label, cond) { if (cond) { pass++; console.log(`  PASS  ${label}`); } else { fail++; console.log(`  FAIL  ${label}`); } }
const bytes = s => Buffer.byteLength(s, 'utf-8');

// ── Build a >1 MB real-shape JSONL fixture ──────────────────────────────────
// Realistic Claude Code shape: assistant turns carry message.content blocks
// (text + tool_use + thinking); user turns carry tool_result blocks. We pad
// with heavy tool_use inputs and tool_result outputs so raw bytes blow past
// 1 MB while the gradable assistant TEXT stays small.
const NOISE = 'X'.repeat(4000); // 4 KB of tool noise per event
const MOST_RECENT = 'SEAT-2 REBUTS: the KEK cache amortizes to +0.2ms per commit ab12cd3 — CONVERGE.';
const OLD_DELIB = 'SEAT-1 (security): the token store MUST be encrypted at rest.';

const lines = [];
// A big pile of tool-noise + a few OLD assistant text turns, oldest first.
for (let i = 0; i < 300; i++) {
  lines.push(JSON.stringify({type: 'assistant', message: {content: [
    {type: 'thinking', thinking: 'internal reasoning ' + NOISE},
    {type: 'tool_use', name: 'Read', input: {file_path: '/x/' + i, blob: NOISE}},
  ]}}));
  lines.push(JSON.stringify({type: 'user', message: {content: [
    {type: 'tool_result', content: 'tool output ' + NOISE},
  ]}}));
  lines.push(JSON.stringify({type: 'assistant', message: {content: [
    {type: 'text', text: `${OLD_DELIB} (turn ${i})`},
  ]}}));
}
// Trailing system-reminder noise + the MOST-RECENT assistant deliberation last.
lines.push(JSON.stringify({type: 'user', message: {content: [{type: 'text', text: '<system-reminder>' + NOISE + '</system-reminder>'}]}}));
lines.push(JSON.stringify({type: 'assistant', message: {content: [{type: 'text', text: MOST_RECENT}]}}));

const hugeJsonl = lines.join('\n') + '\n';
const rawBytes = bytes(hugeJsonl);
check(`fixture is genuinely huge (>1 MB): ${rawBytes} bytes`, rawBytes > 1_000_000);

// ── Mirror the hook: 600-line scan window → extractDeliberation(byte cap) ────
const CAP = DEFAULT_MAX_INPUT_BYTES;
const scanWindow = hugeJsonl.split('\n').slice(-600).join('\n');
const payload = extractDeliberation(scanWindow, {maxBytes: CAP});

check(`assembled transcript payload is < the byte cap (${bytes(payload)} < ${CAP})`, bytes(payload) < CAP);
check('payload retains the MOST-RECENT assistant deliberation', payload.includes(MOST_RECENT));
check('payload drops tool_use / tool_result / thinking noise (no 4 KB X-blob)', !payload.includes(NOISE));
check('payload drops the system-reminder noise', !payload.includes('<system-reminder>'));

// ── most-recent-wins under the byte cap: tighten cap so ONLY recent turns fit ─
{
  const tightCap = 2048;
  const tight = extractDeliberation(scanWindow, {maxBytes: tightCap});
  check(`tight cap honored (${bytes(tight)} <= ${tightCap})`, bytes(tight) <= tightCap);
  check('tight cap keeps the most-recent turn (tail-preserving truncation)', tight.includes(MOST_RECENT));
}

// ── maxTurns bounds how many assistant turns survive ─────────────────────────
{
  const turns = extractAssistantTurns(scanWindow);
  check('extractAssistantTurns returns only assistant text turns (no noise)',
    turns.length > 0 && turns.every(t => !t.includes(NOISE)));
  const kept = extractDeliberation(scanWindow, {maxTurns: 3, maxBytes: CAP});
  // With maxTurns=3 and a generous byte cap, at most 3 turns' worth of text.
  check('maxTurns caps retained turns (most-recent present, deep-old absent)',
    kept.includes(MOST_RECENT) && !kept.includes('(turn 0)'));
}

// ── fail-open: total parse failure → byte-capped raw tail, still < cap ───────
{
  const garbage = 'not json at all\n'.repeat(200_000); // >1 MB of non-JSONL
  check(`garbage fixture is huge (${bytes(garbage)} bytes)`, bytes(garbage) > 1_000_000);
  const out = extractDeliberation(garbage, {maxBytes: CAP});
  check(`fail-open payload is bounded (${bytes(out)} <= ${CAP})`, bytes(out) <= CAP);
  check('fail-open payload is non-empty (reviewer still gets bounded context)', out.length > 0);
}

// ── simple/test transcript shape ({role:'assistant',text}) also extracts ─────
{
  const simple = [
    '{"role":"assistant","text":"Panel seat 1 says A."}',
    '{"role":"user","text":"tool result noise"}',
    '{"role":"assistant","text":"Panel seat 2 CHALLENGES: B."}',
  ].join('\n') + '\n';
  const out = extractDeliberation(simple, {maxBytes: CAP});
  check('simple shape: keeps assistant text', out.includes('seat 2 CHALLENGES'));
  check('simple shape: drops the user turn', !out.includes('tool result noise'));
}

// ── capBytesTail / resolveMaxBytes unit behavior ─────────────────────────────
{
  check('capBytesTail no-op under cap', capBytesTail('short', 1000) === 'short');
  const big = 'A'.repeat(5000);
  const capped = capBytesTail(big, 1000);
  check('capBytesTail enforces the cap', bytes(capped) <= 1000);
  check('capBytesTail marks truncation', capped.includes('truncated'));
  check('capBytesTail handles non-string', capBytesTail(null, 1000) === '' && capBytesTail(undefined, 1000) === '');

  const KEY = 'PRISM_TEST_CAP_' + Date.now();
  delete process.env[KEY];
  check('resolveMaxBytes falls back to default when env unset', resolveMaxBytes(KEY) === DEFAULT_MAX_INPUT_BYTES);
  process.env[KEY] = '4096';
  check('resolveMaxBytes honors a valid env override', resolveMaxBytes(KEY) === 4096);
  process.env[KEY] = 'garbage';
  check('resolveMaxBytes ignores an invalid env override', resolveMaxBytes(KEY) === DEFAULT_MAX_INPUT_BYTES);
  process.env[KEY] = '-5';
  check('resolveMaxBytes ignores a non-positive env override', resolveMaxBytes(KEY) === DEFAULT_MAX_INPUT_BYTES);
  delete process.env[KEY];
}

check('DEFAULT_MAX_INPUT_BYTES within the 100-150 KB band', DEFAULT_MAX_INPUT_BYTES >= 100_000 && DEFAULT_MAX_INPUT_BYTES <= 150_000);
check('DEFAULT_MAX_TURNS is modest (12-20)', DEFAULT_MAX_TURNS >= 12 && DEFAULT_MAX_TURNS <= 20);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
