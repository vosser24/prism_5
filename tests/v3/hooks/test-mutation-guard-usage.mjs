#!/usr/bin/env node
// tests/v3/hooks/test-mutation-guard-usage.mjs
// USAGE TEST for hooks/prism-mutation-guard.mjs (v5.4.0+).
// Exercises the guard end-to-end via spawnSync (the real wire path) with an
// isolated temp HOME (no sentinel => clean parent context) and controlled
// PRISM_MUTATION_GUARD mode. Characterises the deny/allow matrix, every bypass
// path, the three modes, BOM-safe downgrade, and the FIXED heredoc false-positive
// (heredoc body containing `>` — e.g. `->` arrows — used to wrongly block
// legitimate `git merge -m "$(cat <<'EOF' ... EOF)"` calls).
//
// Contract recap (from the hook header):
//   - Only tool_name === 'Bash' is inspected; other tools => allow.
//   - Only commands matching a BASH_WRITE_PATTERN are candidates to block.
//   - Bypass (=> allow even on a write): subagent (parent_tool_use_id /
//     CLAUDE_CODE_ENTRYPOINT=subagent / sentinel.dispatched), file path is
//     .prism-turn-tier-*.json, sentinel.force_opus, !opus-force: prompt,
//     bootstrap command (/prism-update,/prism-archive).
//   - mode hard => deny (exit 2); soft => nudge (exit 0); off => silent (exit 0).
//
// Run: node tests/v3/hooks/test-mutation-guard-usage.mjs

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUARD = join(__dirname, '..', '..', '..', 'hooks', 'prism-mutation-guard.mjs');

let pass = 0, fail = 0;
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }
function test(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n        ${e.message}`); }
}

// Fresh isolated HOME so readSentinel() finds nothing => no bypass by default.
const HOME = mkdtempSync(join(tmpdir(), 'prism-mgtest-'));
mkdirSync(join(HOME, '.claude'), { recursive: true });

// Run the guard as the real hook: pipe a PreToolUse payload on stdin.
// env overrides let us set mode + isolate HOME; CLAUDE_CODE_ENTRYPOINT is
// cleared so the env-subagent bypass never fires unless a case sets it.
function runGuard(payload, { mode, sentinel, sessionId = 'mg', entrypoint } = {}) {
  if (sentinel) {
    writeFileSync(join(HOME, '.claude', `.prism-turn-tier-${sessionId}.json`), JSON.stringify(sentinel));
  }
  const env = { ...process.env, HOME, USERPROFILE: HOME };
  delete env.CLAUDE_CODE_ENTRYPOINT;
  if (entrypoint) env.CLAUDE_CODE_ENTRYPOINT = entrypoint;
  if (mode === undefined) delete env.PRISM_MUTATION_GUARD; else env.PRISM_MUTATION_GUARD = mode;
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ session_id: sessionId, ...payload }),
    encoding: 'utf8', timeout: 15000, windowsHide: true, env,
  });
  return { exit: r.status, stdout: (r.stdout || '').trim() };
}
const bash = (command, extra = {}) => ({ tool_name: 'Bash', tool_input: { command }, ...extra });

try {
  // ── DENY matrix (parent + Bash + write pattern + hard mode) ──────────────
  test('DENY: echo redirect to .json', () => {
    const r = runGuard(bash('echo "{}" > config.json'));
    assert(r.exit === 2, `exit ${r.exit}`);
    assert(/permissionDecision":"deny"/.test(r.stdout) || /MUTATION-GUARD/.test(r.stdout), 'deny payload');
  });
  test('DENY: PowerShell Set-Content', () => {
    assert(runGuard(bash('Set-Content -Path foo.txt -Value bar')).exit === 2);
  });
  test('DENY: PowerShell Out-File', () => {
    assert(runGuard(bash('"x" | Out-File foo.md')).exit === 2);
  });
  test('DENY: sed -i in-place edit', () => {
    assert(runGuard(bash("sed -i 's/a/b/' app/main.js")).exit === 2);
  });
  test('DENY: printf redirect to .sh', () => {
    assert(runGuard(bash('printf "#!/bin/sh\\n" > run.sh')).exit === 2);
  });
  // CHARACTERIZATION: [System.IO.File]::WriteAllText is NOT detected — the
  // pattern /\b\[System\.IO\.File\]::.../ has a dead `\b` before `[` (a word
  // boundary never matches before a leading non-word `[`). This is a false
  // NEGATIVE, but low-harm: it is precisely the BOM-safe writer the guard's own
  // message recommends, and the guard is non-exhaustive by design.
  test('CHARACTERIZE: [System.IO.File]::WriteAllText is NOT caught (false-negative, BOM-safe method)', () => {
    assert(runGuard(bash('[System.IO.File]::WriteAllText($p,$c)')).exit === 0);
  });
  test('DENY: node -e writeFileSync', () => {
    assert(runGuard(bash('node -e "require(\'fs\').writeFileSync(\'x.json\',\'{}\')"')).exit === 2);
  });

  // ── ALLOW matrix (non-write Bash, sinks, fd redirects) ───────────────────
  test('ALLOW: git status (non-write)', () => { assert(runGuard(bash('git status --short')).exit === 0); });
  test('ALLOW: ls', () => { assert(runGuard(bash('ls -la hooks/')).exit === 0); });
  test('ALLOW: read-only cat (no redirect)', () => { assert(runGuard(bash('cat package.json')).exit === 0); });
  test('ALLOW: echo to /dev/null sink', () => { assert(runGuard(bash('echo hi > /dev/null')).exit === 0); });
  test('ALLOW: stderr fd redirect 2>/dev/null', () => { assert(runGuard(bash('node tests/x.mjs 2>/dev/null')).exit === 0); });
  test('ALLOW: plain node test run', () => { assert(runGuard(bash('node tests/v3/hooks/foo.test.mjs')).exit === 0); });
  test('ALLOW: git commit (no file write pattern)', () => { assert(runGuard(bash('git commit -m "msg"')).exit === 0); });

  // ── Tool scope: non-Bash tools are never inspected ───────────────────────
  test('ALLOW: non-Bash tool (Edit) passes through', () => {
    assert(runGuard({ tool_name: 'Edit', tool_input: { file_path: 'a.json' } }).exit === 0);
  });
  test('ALLOW: non-Bash tool (Write) passes through', () => {
    assert(runGuard({ tool_name: 'Write', tool_input: { file_path: 'a.mjs' } }).exit === 0);
  });

  // ── Bypass paths (write pattern present, but should ALLOW) ────────────────
  test('BYPASS: subagent via parent_tool_use_id', () => {
    assert(runGuard(bash('echo x > a.json', { parent_tool_use_id: 'toolu_123' })).exit === 0);
  });
  test('BYPASS: subagent via CLAUDE_CODE_ENTRYPOINT=subagent', () => {
    assert(runGuard(bash('echo x > a.json'), { entrypoint: 'subagent' }).exit === 0);
  });
  test('BYPASS: sentinel.dispatched=true', () => {
    assert(runGuard(bash('echo x > a.json'), { sessionId: 'disp', sentinel: { dispatched: true } }).exit === 0);
  });
  // CHARACTERIZATION: the `.prism-turn-tier-*.json` bypass keys on
  // tool_input.file_path, which a Bash payload does NOT carry (the target is
  // inside `command`). So a Bash redirect to the sentinel is DENIED, and the
  // bypass only ever applied to the Edit/Write tools — which post-v5.4.0 are
  // non-Bash and allowed earlier anyway. The bypass is therefore vestigial for
  // the current Bash-only matcher. (Write the sentinel via the Write tool.)
  test('CHARACTERIZE: Bash redirect to a tier-sentinel path is DENIED (bypass is file_path/Edit-scoped, vestigial)', () => {
    assert(runGuard(bash('echo x > /home/u/.prism-turn-tier-mg.json')).exit === 2);
  });
  test('BYPASS: sentinel.force_opus=true', () => {
    assert(runGuard(bash('echo x > a.json'), { sessionId: 'fo', sentinel: { force_opus: true } }).exit === 0);
  });

  // ── Modes ────────────────────────────────────────────────────────────────
  test('MODE soft: write => exit 0 + nudge text (not blocked)', () => {
    const r = runGuard(bash('echo x > a.json'), { mode: 'soft' });
    assert(r.exit === 0, `exit ${r.exit}`);
    assert(/MUTATION-GUARD/.test(r.stdout), 'nudge text present');
  });
  test('MODE off: write => silent exit 0', () => {
    const r = runGuard(bash('echo x > a.json'), { mode: 'off' });
    assert(r.exit === 0 && r.stdout === '', `exit ${r.exit} stdout "${r.stdout.slice(0,40)}"`);
  });

  // ── BOM-safe downgrade: still DENY (parent write) but no BOM warning text ─
  test('BOM-safe: Set-Content -Encoding UTF8NoBOM still denies, omits BOM warning', () => {
    const r = runGuard(bash('Set-Content -Path f.txt -Value x -Encoding UTF8NoBOM'));
    assert(r.exit === 2, `exit ${r.exit}`);
    assert(!/BOM WARNING/.test(r.stdout), 'BOM warning should be suppressed when -Encoding UTF8NoBOM present');
  });

  // ── FIXED: heredoc body containing `>` no longer over-fires ──────────────
  // The old here-doc pattern used \s (which spans newlines) so a `>` in the
  // heredoc BODY (e.g. `->` arrows) wrongly matched the redirect operator.
  // Fixed by using [ \t] (horizontal-only whitespace) so the pattern only
  // matches when `>` / `>>` and the target filename appear on the SAME LINE
  // as the `<<DELIMITER` — the true `cmd <<EOF > file` form.
  // This unblocks the legitimate `git merge -m "$(cat <<'EOF' ... EOF)"` pattern.
  test('FIXED: heredoc message body with `->` arrows is no longer blocked', () => {
    const cmd = 'git commit -m "$(cat <<\'EOF\'\nfeat: detect->promote->notify\nEOF\n)"';
    const r = runGuard(bash(cmd));
    assert(r.exit === 0, `Expected allow (exit 0) after heredoc regex fix; got ${r.exit}. ` +
      'The here-doc pattern should only match when > appears on the same line as <<DELIMITER.');
  });

  // ── TRUE-POSITIVE regression: cat <<EOF > file still detected as a write ──
  // Confirms the fix did not accidentally drop coverage of real heredoc-to-file.
  test('DENY: heredoc-redirect cat <<EOF > file is still caught as a write', () => {
    const cmd = "cat <<'EOF' > out.json\n{\"key\":\"value\"}\nEOF";
    const r = runGuard(bash(cmd));
    assert(r.exit === 2, `Expected deny (exit 2) for heredoc-to-file; got ${r.exit}. ` +
      'cat <<EOF > out.json must still be detected as a file write.');
  });
} finally {
  rmSync(HOME, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
