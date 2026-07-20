#!/usr/bin/env node
// tests/v3/state/test-prism-panel-json-inject.mjs
//
// D051 Part A — the phase-0d machinery (prism-phase-0d-oob.mjs,
// prism-phase-0d-challenges.mjs, prism-panel-guard.mjs Path B) all fire on a
// PostToolUse Write to a `.prism-task-<sha>/panel.json` path and are fully
// wired, but a live panel has never written that file (0 phase_0d events
// ever fired). This test proves the INDUCEMENT fix: when a turn's sentinel
// carries summon_panel===true, the PANEL-SUMMONING advice emitted by
// hooks/prism-prompt-tier-router.mjs's formatAdvice() (injected into
// additionalContext on every UserPromptSubmit) now CONTAINS a concise
// instruction to write panel.json — the F4-proven injection channel, not the
// SKILL.md-doc-only channel that landed 0/14.
//
// (fire)  formatAdvice(tier='opus', summonPanel=true, ...)  → contains the
//         panel.json-write instruction, both in the self-chair
//         (activeMaster) branch and the @master-orchestrator dispatch branch.
// (quiet) formatAdvice(tier='opus', summonPanel=false, ...) and
//         formatAdvice(tier='haiku'|'sonnet', ...)          → instruction
//         ABSENT — a normal (non-panel) turn is byte-unchanged.
//
// Also exercises the real run() pipeline end-to-end under an isolated temp
// HOME (mirrors tests/v3/hooks/test-userpromptsubmit-dispatcher.mjs and the
// (e)/(f) I/O section of test-explicit-panel-continuation.mjs):
//   (fire, run())  an explicit panel request with strong novel-architecture
//                  signal → additionalContext contains the instruction.
//   (quiet, run()) a routine one-line prompt → additionalContext does NOT
//                  contain it.
//
// Run: node tests/v3/state/test-prism-panel-json-inject.mjs

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const ROUTER_PATH = join(repoRoot, 'hooks', 'prism-prompt-tier-router.mjs');

const { formatAdvice, run } = await import(pathToFileURL(ROUTER_PATH).href);

let pass = 0, total = 0;
function check(label, cond) {
  total++;
  if (cond) { pass++; process.stdout.write(`  ok  ${label}\n`); }
  else       { process.stdout.write(`  FAIL ${label}\n`); }
}

const PANEL_JSON_MARKER = /panel\.json/i;
const WRITE_INSTRUCTION_RE = /WRITE the panel to JSON at.*panel\.json.*BEFORE synthesis/i;
// Precision fix (no-author validator finding): the phase-0d consumers only
// fire on a PostToolUse Write to a path ending exactly `panel.json`. The
// clause must mandate a direct Write tool call and explicitly warn off the
// tempfile+rename / Bash-heredoc recipe taught in phase-0d-adversarial.md
// (that recipe writes via Bash and/or to a .tmp path — both silently never
// fire the consumers).
const DIRECT_WRITE_RE = /direct Write/i;
const NOT_TEMPFILE_BASH_RE = /not.*(tempfile|rename|bash)/i;

// ── (fire) formatAdvice — opus + summon_panel=true, no activeMaster ─────────
{
  const advice = formatAdvice(
    'opus', 'novel architectural request', 'hard',
    true, 'keyword-floor', 'test-sess', null, false,
  );
  check('(fire) no-activeMaster panel branch: contains panel.json write instruction',
    PANEL_JSON_MARKER.test(advice) && WRITE_INSTRUCTION_RE.test(advice));
  check('(fire) instruction names the schema (positions/specialist/title/challenges)',
    /"positions"/.test(advice) && /"specialist"/.test(advice) && /"title"/.test(advice) && /"challenges"/.test(advice) && /"evidence_class"/.test(advice));
  check('(fire) instruction mandates a direct Write tool call and warns off tempfile/rename/Bash',
    DIRECT_WRITE_RE.test(advice) && NOT_TEMPFILE_BASH_RE.test(advice));
}

// ── (fire) formatAdvice — opus + summon_panel=true, self-chair activeMaster ─
{
  const advice = formatAdvice(
    'opus', 'novel architectural request', 'hard',
    true, 'keyword-floor', 'test-sess', 'master-prism-3', false,
  );
  check('(fire) activeMaster self-chair branch: contains panel.json write instruction',
    PANEL_JSON_MARKER.test(advice) && WRITE_INSTRUCTION_RE.test(advice));
}

// ── (fire) idempotency: instruction appears exactly ONCE per advice string ──
{
  const advice = formatAdvice(
    'opus', 'novel architectural request', 'hard',
    true, 'keyword-floor', 'test-sess', null, false,
  );
  const occurrences = (advice.match(/panel\.json/gi) || []).length;
  check('(fire) panel.json mentioned exactly once (idempotency guard did not double-append)',
    occurrences === 1);
}

// ── (quiet) formatAdvice — opus tier, summon_panel=false ────────────────────
{
  const advice = formatAdvice(
    'opus', 'deep design work', 'hard',
    false, 'keyword-floor', 'test-sess', null, false,
  );
  check('(quiet) opus w/o panel: instruction ABSENT', !PANEL_JSON_MARKER.test(advice));
}

// ── (quiet) formatAdvice — haiku / sonnet routine tiers ─────────────────────
{
  const adviceHaiku = formatAdvice('haiku', 'trivial lookup', 'hard', false, 'keyword-floor', 'test-sess', null, false);
  const adviceSonnet = formatAdvice('sonnet', 'standard review', 'hard', false, 'keyword-floor', 'test-sess', null, false);
  check('(quiet) haiku tier: instruction ABSENT', !PANEL_JSON_MARKER.test(adviceHaiku));
  check('(quiet) sonnet tier: instruction ABSENT', !PANEL_JSON_MARKER.test(adviceSonnet));
}

// ── (quiet) panelDisabled=true (Arm B) suppresses the panel branch entirely ─
{
  const advice = formatAdvice('opus', 'novel architectural request', 'hard', true, 'keyword-floor', 'test-sess', null, true);
  check('(quiet) panelDisabled=true: instruction ABSENT (panel branch itself suppressed)', !PANEL_JSON_MARKER.test(advice));
}

// ── Real pipeline: run() under isolated temp HOME ───────────────────────────
function fakeHome(label) { return mkdtempSync(join(tmpdir(), `prism-panel-inject-${label}-`)); }

// (fire, run()) explicit panel request + strong novel-architecture signal.
{
  const home = fakeHome('fire');
  const prevCwd = process.cwd();
  const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
  try {
    process.env.HOME = home; process.env.USERPROFILE = home; process.chdir(home);
    const result = await run({
      prompt: 'run the expert panel to architect a new multi-tenant billing system migration',
      session_id: 's-fire',
      cwd: home,
    });
    let advice = '';
    try { advice = JSON.parse(result.stdout || '{}')?.hookSpecificOutput?.additionalContext || ''; } catch {}
    check('(fire, run()) exit 0', result.exit === 0);
    check('(fire, run()) additionalContext contains PANEL-SUMMONING TURN', /PANEL-SUMMONING TURN/i.test(advice));
    check('(fire, run()) additionalContext contains panel.json write instruction', PANEL_JSON_MARKER.test(advice));
  } finally {
    process.env.HOME = prevH; process.env.USERPROFILE = prevU; process.chdir(prevCwd);
    rmSync(home, { recursive: true, force: true });
  }
}

// (quiet, run()) routine one-line prompt — summon_panel stays false/absent.
{
  const home = fakeHome('quiet');
  const prevCwd = process.cwd();
  const prevH = process.env.HOME, prevU = process.env.USERPROFILE;
  try {
    process.env.HOME = home; process.env.USERPROFILE = home; process.chdir(home);
    const result = await run({
      prompt: 'fix a typo in the readme',
      session_id: 's-quiet',
      cwd: home,
    });
    let advice = '';
    try { advice = JSON.parse(result.stdout || '{}')?.hookSpecificOutput?.additionalContext || ''; } catch {}
    check('(quiet, run()) exit 0', result.exit === 0);
    check('(quiet, run()) additionalContext does NOT contain panel.json write instruction', !PANEL_JSON_MARKER.test(advice));
  } finally {
    process.env.HOME = prevH; process.env.USERPROFILE = prevU; process.chdir(prevCwd);
    rmSync(home, { recursive: true, force: true });
  }
}

process.stdout.write(`\n${pass} passed, ${total - pass} failed (${total} total)\n`);
process.exit(pass === total ? 0 : 1);
