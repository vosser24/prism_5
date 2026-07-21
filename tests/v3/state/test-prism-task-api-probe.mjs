#!/usr/bin/env node
// Task-API availability probe — both-paths guard (D042) + tri-state honesty (D047).
//
// Plan: docs/prism/plans/2026-07-21-task-api-detection-gap-FIX-PLAN.md
//
// The defect this locks: when the Claude Code harness refuses Task tools
// ("Error: No such tool available: TaskCreate. TaskCreate exists but is not
// enabled in this context."), PRISM's entire task-carryover subsystem
// degrades to a silent no-op and NOTHING reports it — /prism-health,
// /prism-doctor and `installer verify` contain no probe, and the one advisory
// that was believed to fire (task_snapshot_integrity's `degraded` flag) does
// NOT fire, because the refusal row's `toolUseResult` sibling is the error
// STRING (non-null) and therefore counts as a `structured_hit` (test 12).
//
// Wire shape below is copied from real on-disk transcripts under
// ~/.claude/projects/Y--Documents-utilities-projects-prism-3/ (f128de77,
// a2017fb3), not invented.
//
// Run: node tests/v3/state/test-prism-task-api-probe.mjs

import {readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; process.stdout.write(`  ok  ${name}\n`); }
  else { fail++; process.stdout.write(`  FAIL ${name}${extra ? ` -- ${extra}` : ''}\n`); }
}

const {probeTaskApiLines, probeTaskApiTranscript} =
  await import(pathToFileURL(join(ROOT, 'hooks', 'lib', 'prism-task-api-probe.mjs')).href);
const {extractTaskSnapshot} =
  await import(pathToFileURL(join(ROOT, 'hooks', 'lib', 'prism-task-snapshot.mjs')).href);

// ── fixture builders (real wire shape) ─────────────────────────────────────
function toolUseLine(name, id, input = {}) {
  return JSON.stringify({type: 'assistant', message: {role: 'assistant', content: [{type: 'tool_use', id, name, input}]}});
}
function refusalLine(name, id) {
  const msg = `Error: No such tool available: ${name}. ${name} exists but is not enabled in this context. Use one of the available tools instead.`;
  return JSON.stringify({
    type: 'user',
    message: {role: 'user', content: [{type: 'tool_result', content: `<tool_use_error>${msg}</tool_use_error>`, is_error: true, tool_use_id: id}]},
    toolUseResult: msg,
  });
}
function successLine(id, taskId) {
  return JSON.stringify({
    type: 'user',
    message: {role: 'user', content: [{type: 'tool_result', content: `Task #${taskId} created`, tool_use_id: id}]},
    toolUseResult: {task: {id: String(taskId), subject: 'x'}},
  });
}
const REFUSED_TASKCREATE = [toolUseLine('TaskCreate', 'tu_1', {subject: 's'}), refusalLine('TaskCreate', 'tu_1')];

// ── 1. FIRES on a bad input (D042 leg 1) ───────────────────────────────────
{
  const r = probeTaskApiLines(REFUSED_TASKCREATE);
  check('1 refused TaskCreate -> status=unavailable', r.status === 'unavailable', `got ${r.status}`);
  check('1 refused_tools.TaskCreate === 1', r.refused_tools && r.refused_tools.TaskCreate === 1, JSON.stringify(r.refused_tools));
  check('1 task_calls_observed === 1', r.task_calls_observed === 1, String(r.task_calls_observed));
  check('1 first_refusal carries the tool + id', r.first_refusal && r.first_refusal.tool === 'TaskCreate' && r.first_refusal.tool_use_id === 'tu_1');
}

// ── 2. STAYS QUIET on a good input (D042 leg 2) ────────────────────────────
{
  const r = probeTaskApiLines([toolUseLine('TaskCreate', 'tu_2', {subject: 's'}), successLine('tu_2', 7)]);
  check('2 successful TaskCreate -> status=available', r.status === 'available', `got ${r.status}`);
  check('2 refused === 0', r.refused === 0);
  check('2 succeeded === 1', r.succeeded === 1);
}

// ── 3. THIRD STATE is representable (D047) — never-measured != available ───
{
  const r = probeTaskApiLines([JSON.stringify({type: 'assistant', message: {role: 'assistant', content: [{type: 'text', text: 'hello'}]}})]);
  check('3 no Task calls -> status=unknown (NOT available)', r.status === 'unknown', `got ${r.status}`);
  check('3 reason=no_task_calls_in_window', r.reason === 'no_task_calls_in_window', String(r.reason));
}

// ── 4/5. could-not-measure is distinct from never-measured ─────────────────
{
  const r = probeTaskApiTranscript(join(tmpdir(), 'prism-no-such-transcript-xyz.jsonl'));
  check('4 missing transcript -> unknown/transcript_missing', r.status === 'unknown' && r.reason === 'transcript_missing', `${r.status}/${r.reason}`);
  const r2 = probeTaskApiTranscript(null);
  check('5 null path -> unknown/no_transcript_path', r2.status === 'unknown' && r2.reason === 'no_transcript_path', `${r2.status}/${r2.reason}`);
}

// ── 6. prose false-positive guard (real: transcript 68125b7c) ──────────────
{
  const prose = JSON.stringify({type: 'assistant', message: {role: 'assistant', content: [{type: 'text',
    text: 'The error was: Error: No such tool available: TaskCreate. TaskCreate exists but is not enabled in this context.'}]}});
  const r = probeTaskApiLines([prose]);
  check('6 error phrase in prose -> NOT unavailable', r.status !== 'unavailable', `got ${r.status}`);
  check('6 error phrase in prose -> unknown', r.status === 'unknown');
}

// ── 7. non-Task refusal does not drive the verdict ─────────────────────────
{
  const r = probeTaskApiLines([toolUseLine('Agent', 'tu_a', {}), refusalLine('Agent', 'tu_a')]);
  check('7 refused Agent -> NOT unavailable', r.status !== 'unavailable', `got ${r.status}`);
  check('7 refused Agent recorded as context', r.other_refused_tools && r.other_refused_tools.Agent === 1, JSON.stringify(r.other_refused_tools));
  check('7 refused Agent is not expected_unavailable', Object.keys(r.expected_unavailable).length === 0);
  check('7 refused_tools stays empty', r.refused_tools && Object.keys(r.refused_tools).length === 0);
}

// ── 8. TodoWrite + TaskGet are known-never-available: refusal is EXPECTED and
// must never move the verdict (D018 for TodoWrite; corpus-measured for TaskGet).
{
  const r = probeTaskApiLines([toolUseLine('TodoWrite', 'tu_t', {}), refusalLine('TodoWrite', 'tu_t')]);
  check('8 refused TodoWrite -> NOT unavailable', r.status !== 'unavailable', `got ${r.status}`);
  check('8 refused TodoWrite -> expected_unavailable', r.expected_unavailable && r.expected_unavailable.TodoWrite === 1);
  const g = probeTaskApiLines([toolUseLine('TaskGet', 'tu_g0', {taskId: '3'}), refusalLine('TaskGet', 'tu_g0')]);
  check('8 refused TaskGet alone -> unknown (nothing decision-relevant observed)', g.status === 'unknown', `got ${g.status}`);
  check('8 refused TaskGet -> expected_unavailable', g.expected_unavailable && g.expected_unavailable.TaskGet === 1);
  check('8 refused TaskGet does not count as refused', g.refused === 0);
}

// ── 9. mixed — requires a SCORING tool to be refused alongside a success ────
{
  const r = probeTaskApiLines([
    toolUseLine('TaskList', 'tu_l', {}), refusalLine('TaskList', 'tu_l'),
    toolUseLine('TaskCreate', 'tu_c', {subject: 's'}), successLine('tu_c', 9),
  ]);
  check('9 scoring refusal + success -> status=mixed', r.status === 'mixed', `got ${r.status}`);
  check('9 task_calls_observed === 2', r.task_calls_observed === 2, String(r.task_calls_observed));
  // The TaskGet variant must NOT be mixed — that is the production defect.
  const g = probeTaskApiLines([
    toolUseLine('TaskGet', 'tu_g', {taskId: '3'}), refusalLine('TaskGet', 'tu_g'),
    toolUseLine('TaskCreate', 'tu_c2', {subject: 's'}), successLine('tu_c2', 9),
  ]);
  check('9 TaskGet refusal + success -> available (NOT mixed)', g.status === 'available', `got ${g.status}`);
  check('9 TaskGet excluded from the verdict denominator', g.task_calls_observed === 1, String(g.task_calls_observed));
}

// ── 10. the denominator is always printed alongside the verdict ────────────
{
  const cases = [
    probeTaskApiLines(REFUSED_TASKCREATE),
    probeTaskApiLines([]),
    probeTaskApiTranscript(null),
    probeTaskApiTranscript(join(tmpdir(), 'nope.jsonl')),
  ];
  check('10 every result carries task_calls_observed', cases.every(c => 'task_calls_observed' in c));
  check('10 every result carries status', cases.every(c => typeof c.status === 'string'));
}

// ── 11. never throws ───────────────────────────────────────────────────────
{
  let threw = null;
  try {
    probeTaskApiLines(['{not json', '', 'null', JSON.stringify({message: null}), JSON.stringify({message: {content: 'str'}})]);
    probeTaskApiLines(null);
    probeTaskApiLines(undefined);
    probeTaskApiLines('not an array');
  } catch (err) { threw = err; }
  check('11 malformed input never throws', threw === null, threw && threw.message);
  check('11 null input still returns a status', probeTaskApiLines(null).status === 'unknown');
}

// ── 12. characterization: the PRE-EXISTING advisory does NOT fire ──────────
// This is WHY the probe is needed. If this ever flips to degraded===true,
// re-read the plan's §6 — the routing-around may no longer be necessary.
{
  const counters = {structured_hits: 0, regex_fallbacks: 0, unmatched_task_results: 0};
  extractTaskSnapshot(REFUSED_TASKCREATE, counters);
  const seen = counters.structured_hits + counters.regex_fallbacks + counters.unmatched_task_results;
  const degraded = seen > 0 && counters.structured_hits === 0;
  check('12 task_snapshot_integrity degraded stays FALSE on a refusal (the gap)', degraded === false, JSON.stringify(counters));
  check('12 refusal counts as a structured_hit (the vacuity)', counters.structured_hits === 1, JSON.stringify(counters));
}

// ── 13. wiring: the SessionEnd hook actually calls the probe ───────────────
{
  const src = readFileSync(join(ROOT, 'hooks', 'prism-session-end.mjs'), 'utf-8');
  check('13 session-end imports the probe', /prism-task-api-probe\.mjs/.test(src));
  check('13 session-end emits task_api_unavailable', /task_api_unavailable/.test(src));
}

// ── 14. install-manifest coverage (D047 §2a P0 shape) ──────────────────────
{
  const raw = readFileSync(join(ROOT, 'tools', 'install-manifest.json'), 'utf-8');
  check('14 manifest lists hooks/lib/prism-task-api-probe.mjs', raw.includes('hooks/lib/prism-task-api-probe.mjs'));
  check('14 manifest lists tools/prism-task-api-probe.mjs', raw.includes('tools/prism-task-api-probe.mjs'));
}

// ── 15. surface: /prism-doctor names the probe ─────────────────────────────
{
  const doc = readFileSync(join(ROOT, 'commands', 'prism-doctor.md'), 'utf-8');
  check('15 prism-doctor references the probe CLI', /prism-task-api-probe/.test(doc));
  const health = readFileSync(join(ROOT, 'commands', 'prism-health.md'), 'utf-8');
  check('15 prism-health references the probe CLI', /prism-task-api-probe/.test(health));
  check('15 the CLI file exists', existsSync(join(ROOT, 'tools', 'prism-task-api-probe.mjs')));
}

// ── 16. CLI contract: --json on a fixture file ─────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'prism-taskprobe-'));
  const f = join(dir, 'fixture.jsonl');
  writeFileSync(f, REFUSED_TASKCREATE.join('\n'), 'utf-8');
  const r = probeTaskApiTranscript(f);
  check('16 probeTaskApiTranscript on a real file -> unavailable', r.status === 'unavailable', `got ${r.status}`);
  check('16 result carries transcript_path', r.transcript_path === f);
  check('16 result carries tail_truncated', typeof r.tail_truncated === 'boolean');
}

// ── 17. The probe owns an UNBIASED scan window.
// readTaskScanLines' prefilter (/Task|task/ AND /tool_use|toolUseResult/) keeps
// every refusal row (the error text names the tool) but drops success rows whose
// payload lacks the substring "task" — biasing the verdict toward `unavailable`.
// The probe must use its own tool-bearing filter so successes survive, and must
// therefore also be able to genuinely measure non-Task refusals.
{
  const dir = mkdtempSync(join(tmpdir(), 'prism-taskprobe2-'));
  const f = join(dir, 'fixture.jsonl');
  writeFileSync(f, [
    ...REFUSED_TASKCREATE,
    toolUseLine('Agent', 'tu_ag', {}), refusalLine('Agent', 'tu_ag'),
  ].join('\n'), 'utf-8');
  const r = probeTaskApiTranscript(f);
  check('17 transcript path genuinely measures other_refused_tools', r.other_refused_tools && r.other_refused_tools.Agent === 1, JSON.stringify(r.other_refused_tools));
  check('17 transcript path flags other_refused_tools_scanned=true', r.other_refused_tools_scanned === true);
  check('17 Task verdict correct', r.status === 'unavailable' && r.refused_tools.TaskCreate === 1);

  // The bias regression: a success row whose payload contains no "task"
  // substring must still be counted. Under readTaskScanLines it was dropped,
  // turning a healthy session into `unknown` (or worse, `unavailable`).
  const f2 = join(dir, 'nokeyword.jsonl');
  writeFileSync(f2, [
    toolUseLine('TaskCreate', 'tu_n', {}),
    JSON.stringify({type: 'user', message: {role: 'user', content: [{type: 'tool_result', content: 'ok', is_error: false, tool_use_id: 'tu_n'}]}, toolUseResult: {ok: true}}),
  ].join('\n'), 'utf-8');
  const r2 = probeTaskApiTranscript(f2);
  check('17 success row without a "task" substring is still counted', r2.status === 'available' && r2.succeeded === 1, `${r2.status}/${r2.succeeded}`);
}

// ── 18. REAL-TRANSCRIPT FIXTURES (both D042 legs, on production data) ──────
// Provenance + distillation method: tests/v3/state/fixtures/task-api/README.md.
// Committed rather than read from ~/.claude/projects/ because that directory is
// pruned by cleanupPeriodDays (default 30) — a live-reading test would lose its
// denominator silently.
{
  const FX = (n) => join(__dirname, 'fixtures', 'task-api', n);

  // 18a — FIRES on the real broken session.
  const bad = probeTaskApiTranscript(FX('refused-taskcreate.jsonl'));
  check('18a real refusal fixture -> unavailable', bad.status === 'unavailable', `got ${bad.status}`);
  check('18a refused_tools.TaskCreate === 7', bad.refused_tools.TaskCreate === 7, JSON.stringify(bad.refused_tools));
  check('18a succeeded === 0', bad.succeeded === 0);
  check('18a TodoWrite refusal is bucketed as expected_unavailable, not as ill-health',
    bad.expected_unavailable && bad.expected_unavailable.TodoWrite === 1, JSON.stringify(bad.expected_unavailable));

  // 18b — STAYS QUIET on the real healthy session. This fixture also carries
  // an assistant TEXT block quoting the refusal string, so it simultaneously
  // proves the prose false-positive is not triggered.
  const good = probeTaskApiTranscript(FX('healthy-no-refusals.jsonl'));
  check('18b real healthy fixture -> available', good.status === 'available', `got ${good.status}`);
  check('18b refused === 0 despite the phrase appearing in prose', good.refused === 0, String(good.refused));

  // 18c — THE REGRESSION FOR THE TaskGet DEFECT.
  // TaskGet has ZERO successes in the entire local corpus (0 ok / 2 refused,
  // measured 2026-07-21) — it is documented for the Agent SDK but is not
  // exposed by the interactive CLI. Healthy sessions therefore refuse TaskGet
  // routinely while TaskCreate/TaskUpdate/TaskList all succeed. Scoring the
  // verdict on "any Task refusal" reports those healthy sessions as broken,
  // which fails D042's stay-quiet leg on production data.
  const healthyGet = probeTaskApiTranscript(FX('healthy-with-taskget-refusal.jsonl'));
  check('18c MIXED-HEALTHY (TaskGet refusal + successes) -> available, NOT degraded',
    healthyGet.status === 'available', `got ${healthyGet.status}`);
  check('18c TaskGet refusal does not count as refused', healthyGet.refused === 0, String(healthyGet.refused));
  check('18c TaskGet refusal is bucketed as expected_unavailable',
    healthyGet.expected_unavailable && healthyGet.expected_unavailable.TaskGet === 1, JSON.stringify(healthyGet.expected_unavailable));

  // 18d — a GENUINE mixed session: TaskUpdate (592 corpus successes) refused
  // alongside 4 successes IN THE SAME SESSION.
  const mixed = probeTaskApiTranscript(FX('mixed-taskupdate-refusal.jsonl'));
  check('18d real mixed fixture -> mixed', mixed.status === 'mixed', `got ${mixed.status}`);
  check('18d refused_tools.TaskUpdate === 1', mixed.refused_tools.TaskUpdate === 1);
  check('18d succeeded > 0 in the SAME session (refutes a session-global cause)', mixed.succeeded > 0);

  // 18e — the unknown third state, from a file.
  const none = probeTaskApiTranscript(FX('no-task-calls.jsonl'));
  check('18e no-task-calls fixture -> unknown', none.status === 'unknown', `got ${none.status}`);
  check('18e reason=no_task_calls_in_window', none.reason === 'no_task_calls_in_window', String(none.reason));
  check('18e task_calls_observed === 0', none.task_calls_observed === 0);
}

// ── 19. DOCUMENTED EDGE: a UTF-8 BOM swallows transcript line 1 ────────────
// JSON.parse rejects a BOM-prefixed line, so line 1's Task activity is lost.
// This is ACCEPTED behaviour (real transcripts carry no BOM) on one condition,
// which this test pins: the loss can only ever degrade the verdict toward
// `unknown`. It must NEVER turn into a false `available` — the probe may
// under-count its own evidence, it may not fabricate a green.
{
  const dir = mkdtempSync(join(tmpdir(), 'prism-taskprobe-bom-'));

  // 19a — the worst case: the ONLY Task activity starts on line 1. The
  // tool_use is lost, so its result cannot be attributed to any tool.
  const fBom = join(dir, 'bom-refusal.jsonl');
  writeFileSync(fBom, '﻿' + REFUSED_TASKCREATE.join('\n'), 'utf-8');
  const rBom = probeTaskApiTranscript(fBom);
  check('19a BOM file never yields a false green', rBom.status !== 'available', `got ${rBom.status}`);
  check('19a BOM file degrades to unknown', rBom.status === 'unknown', `got ${rBom.status}`);
  check('19a BOM file reports the honest denominator 0', rBom.task_calls_observed === 0, String(rBom.task_calls_observed));

  // 19b — same for a SUCCESS on line 1: it is dropped, so the healthy session
  // reads as unknown rather than available. Under-count, never over-claim.
  const fBomOk = join(dir, 'bom-success.jsonl');
  writeFileSync(fBomOk, '﻿' + [toolUseLine('TaskCreate', 'tu_b2', {}), successLine('tu_b2', 5)].join('\n'), 'utf-8');
  const rBomOk = probeTaskApiTranscript(fBomOk);
  check('19b BOM drops a line-1 success -> unknown (under-count, not over-claim)',
    rBomOk.status === 'unknown', `got ${rBomOk.status}`);

  // 19c — ONLY line 1 is affected: identical content one line down parses fine.
  const fBomLater = join(dir, 'bom-later.jsonl');
  writeFileSync(fBomLater, '﻿' + [
    JSON.stringify({type: 'assistant', message: {role: 'assistant', content: [{type: 'text', text: 'tool_use padding'}]}}),
    ...REFUSED_TASKCREATE,
  ].join('\n'), 'utf-8');
  const rLater = probeTaskApiTranscript(fBomLater);
  check('19c BOM affects line 1 only -> later refusal still fires', rLater.status === 'unavailable', `got ${rLater.status}`);
}

// ── 20. NAMING: auto-discovery with no resolvable path -> no_transcript_path ─
// §3.4 originally specified `transcript_missing` for a nonexistent project dir.
// The CODE is the more honest of the two and was kept: `transcript_missing`
// asserts that a specific file was identified and found absent, which is false
// here — no path was ever resolved. The PLAN was corrected to match (§5d.2).
{
  const dir = mkdtempSync(join(tmpdir(), 'prism-taskprobe-cli-'));
  const fakeConfig = join(dir, 'claude-config');
  mkdirSync(join(fakeConfig, 'projects'), {recursive: true});
  const absentProject = join(dir, 'no-such-project-dir');
  const res = spawnSync(process.execPath, [
    join(ROOT, 'tools', 'prism-task-api-probe.mjs'),
    '--project-dir', absentProject, '--json',
  ], {encoding: 'utf-8', env: {...process.env, CLAUDE_CONFIG_DIR: fakeConfig}});
  let parsed = null;
  try { parsed = JSON.parse(res.stdout); } catch {}
  check('20 CLI auto-discovery over an absent project dir -> unknown',
    !!parsed && parsed.status === 'unknown', res.stdout);
  check('20 reason is no_transcript_path (code kept; plan corrected)',
    !!parsed && parsed.reason === 'no_transcript_path', parsed && parsed.reason);
  check('20 exit code 2 — "didn\'t check" must not read as "fine"', res.status === 2, String(res.status));
  check('20 the attempted lookup is disclosed via searched_dir',
    !!parsed && typeof parsed.searched_dir === 'string' && parsed.searched_dir.length > 0, parsed && parsed.searched_dir);
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
