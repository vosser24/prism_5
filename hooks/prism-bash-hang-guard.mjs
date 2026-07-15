#!/usr/bin/env node
// PRISM Bash Hang Guard (v1.0.0) — PreToolUse:Bash
//
// PROBLEM: a hang-prone Bash command (an unbounded `while true` poll, `tail -f`,
// a long foreground `sleep`, a state-file polling loop, or a mass-kill storm)
// has no TTY/operator to Ctrl-C it under Claude Code and wedges the session.
// A real WinError-5 incident here came from tight-polling init_state.json in a
// loop. This guard blocks the narrow, PROVABLE hang patterns and lets everything
// else through.
//
// TOPOLOGY — composes with the existing Bash PreToolUse guards via the in-process
// dispatcher (prism-pretooluse-dispatcher.mjs). It exports run(payload) →
// {exit, stdout, stderr} like its siblings (prism-safety, prism-mutation-guard,
// prism-parent-dispatch-guard). NO new settings.json entry is added — the file is
// added to the dispatcher's Bash ROUTE so the most-restrictive-wins merge unifies
// its verdict with the other Bash guards. A separate settings entry would re-spawn
// node and risk double-blocking.
//
// THE #1 INVARIANT — FAIL OPEN. On any error, parse failure, missing field, or
// non-match the guard returns exit 0 (allow). It ONLY returns exit 2 (block) on a
// clear, positive match against a hang pattern. Over-blocking is a failure: a
// bounded `for f in *.x; do …; done`, a normal one-shot command, and a legitimate
// `run_in_background:true` server launch (waitress/uvicorn) all PASS.
//
// MODE (PRISM_BASH_HANG_GUARD env var, default hard):
//   hard (default) — deny matched hang patterns; exit 2 with deny JSON + stderr.
//   soft           — advisory additionalContext only; exit 0.
//   off            — pass-through.

import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { prismHome } from './lib/prism-home.mjs';

function mode(env = process.env) {
  return String(env.PRISM_BASH_HANG_GUARD ?? 'hard').toLowerCase();
}

function appendLog(obj) {
  try {
    const p = join(prismHome(), '.claude', '.prism-routing.jsonl');
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(obj) + '\n');
  } catch { /* fail-open */ }
}

// Strip single/double-quoted segments and heredoc bodies so a hang token that
// only appears inside a STRING/DATA (echo "while true ..." , a commit message,
// a grep pattern) cannot trip the guard. We scan the de-quoted view.
function stripQuotesAndHeredocs(s) {
  let c = s;
  // heredoc bodies are data unless shell-executed; strip the whole body.
  c = c.replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n[ \t]*\2(?=\s|$)/g, ' ');
  c = c.replace(/'[^']*'|"[^"]*"/g, ' ');
  return c;
}

// Each rule: {id, re, why, fix}. `re` is tested against the de-quoted view.
// Rules are intentionally narrow — a false POSITIVE (blocking a safe command)
// is the failure mode we most fear, so each pattern requires a structural
// hang signature, not a mere keyword mention.
function buildRules() {
  return [
    // ── 1. Infinite / unbounded loops ────────────────────────────────────────
    {
      id: 'while-true',
      // `while true`, `while :`, `until false` — the canonical infinite loop.
      // Note: no trailing \b — `:` is not a word char (e.g. `while :;`) so a
      // \b after the alternation would fail to match the `:` form.
      re: /\b(while\s+(true|:)|until\s+false)(\b|\s|;|$)/i,
      why: 'unbounded infinite loop (while true / while : / until false)',
      fix: 'Add a bounded exit condition or a max-iteration counter. To watch a long job, launch it with run_in_background:true and poll its status with separate one-shot Bash calls, not an in-shell infinite loop.',
    },
    // ── 2. Polling loop: a while/for/until whose body contains `sleep` ────────
    // A loop keyword that also contains a `sleep` call in the same command is a
    // poll loop. The do…done / loop body and the sleep are matched together.
    {
      id: 'poll-sleep-loop',
      re: /\b(while|until|for)\b[\s\S]*?\bdo\b[\s\S]*?\bsleep\b/i,
      why: 'polling loop (a while/for/until loop whose body calls sleep)',
      fix: 'Polling in-shell wedges the session (real WinError-5 incident here came from tight-polling init_state.json). Launch the worker with run_in_background:true and poll with separate one-shot Bash reads, or use the Monitor tool.',
    },
    // ── 3. Tight-polling a state file (loop reading *_state / *.lock / init_state) ─
    // Catches the specific init_state.json repeated-read pattern even when it
    // is dressed as a `while`/`for` without an obvious sleep.
    {
      id: 'state-file-poll',
      // The state/lock file may appear in the loop CONDITION (`until grep x lock; do`)
      // OR the body, so scan from the loop keyword through the rest of the command.
      re: /\b(while|until|for)\b[\s\S]*?(init_state\.json|[\w.\-]*state\.json|\.reclassify_lock|[\w.\-]*\.lock)\b/i,
      why: 'loop repeatedly reading a state/lock file (tight state-file poll)',
      fix: 'Tight-polling a state file in a loop caused a WinError-5 hang here. Read the file ONCE per one-shot call; if you must wait for a state change, run the producer with run_in_background:true and check status between turns.',
    },
    // ── 4. Unbounded follow / watch ──────────────────────────────────────────
    {
      id: 'tail-follow',
      // `tail -f`, `tail --follow`, with or without other flags.
      re: /\btail\b[^\n|;&]*\s(-[a-zA-Z]*f[a-zA-Z]*|--follow)\b/i,
      why: 'unbounded follow (tail -f / tail --follow never returns)',
      fix: 'Use a bounded read instead: `tail -n 200 <file>`. If you need to watch a growing log, launch the producer with run_in_background:true and re-read the tail between turns.',
    },
    {
      id: 'watch-cmd',
      // `watch ` as a leading command token (not `git switch`, not a path).
      re: /(^|[\s;&|])watch\s+\S/i,
      why: 'watch re-runs a command forever (never returns)',
      fix: 'Run the command once. To re-check periodically, do separate one-shot Bash calls across turns.',
    },
    {
      id: 'get-content-wait',
      // PowerShell-style follow that can appear in a Bash-launched pwsh -c.
      // scanRaw: Get-Content -Wait is almost always passed as a QUOTED argument
      // (`pwsh -c "Get-Content app.log -Wait"`), so the de-quoted view would
      // strip it (a false-negative). Scan the raw command like taskkill /FI.
      re: /get-content\b[^\n|;&]*\s-wait\b/i,
      scanRaw: true,
      why: 'Get-Content -Wait follows a file forever (never returns)',
      fix: 'Use `Get-Content -Tail 200 <file>` for a bounded read instead of -Wait.',
    },
    // ── 6. Mass-kill storms ──────────────────────────────────────────────────
    // taskkill targeting by IMAGE NAME or wildcard (NOT a single /PID).
    {
      id: 'taskkill-image',
      re: /\btaskkill\b[^\n]*\s\/im\b/i,
      why: 'taskkill /IM kills ALL processes by image name (mass-kill storm)',
      fix: 'Kill one process by PID: `taskkill /PID <n> /F`. Identify the exact PID first (e.g. via tasklist) and target only it.',
    },
    {
      id: 'taskkill-wildcard',
      // Wildcard target. Scanned RAW (see scanRaw flag) because the wildcard
      // usually lives inside a quoted /FI filter that quote-stripping removes.
      re: /\btaskkill\b[^\n]*\*/i,
      scanRaw: true,
      why: 'taskkill with a wildcard is a mass-kill storm',
      fix: 'Kill one process by PID: `taskkill /PID <n> /F`.',
    },
    {
      id: 'taskkill-filter',
      // `/FI` filter-based kill targets a SET of processes by criteria — a
      // mass-kill by construction. A single `/PID <n>` is not a filter and passes.
      re: /\btaskkill\b[^\n]*\s\/fi\b/i,
      scanRaw: true,
      why: 'taskkill /FI kills every process matching a filter (mass-kill storm)',
      fix: 'Kill one process by PID: `taskkill /PID <n> /F`. Resolve the exact PID first (e.g. via tasklist) and target only it.',
    },
    {
      id: 'pkill',
      re: /(^|[\s;&|])pkill\b/i,
      why: 'pkill kills processes by name/pattern (mass-kill storm)',
      fix: 'Find the exact PID (`ps`, `tasklist`) and kill only it: `kill <pid>` / `taskkill /PID <pid> /F`.',
    },
    {
      id: 'killall',
      re: /(^|[\s;&|])killall\b/i,
      why: 'killall kills every process matching a name (mass-kill storm)',
      fix: 'Find the exact PID and kill only it.',
    },
    {
      id: 'stop-process-name',
      // Stop-Process -Name <x> or Stop-Process targeting a wildcard. A
      // Stop-Process -Id <pid> (single PID) is NOT matched (allowed cleanup).
      re: /stop-process\b[^\n]*(-name\b|\*)/i,
      why: 'Stop-Process -Name / wildcard kills processes by name (mass-kill storm)',
      fix: 'Target a single PID: `Stop-Process -Id <pid> -Force`.',
    },
  ];
}

// Detect a long FOREGROUND sleep: `sleep N` (or `sleep Nm`/`Nh`) > threshold,
// when NOT run in background. Short sleeps (a 1-2s settle) are routine and pass.
// Sleeps inside a loop are already caught by poll-sleep-loop; this catches a
// bare long foreground sleep. Returns the matched seconds or null.
function longForegroundSleepSeconds(deQuoted) {
  // Match `sleep` as a command token followed by a number with optional unit.
  const re = /(^|[\s;&|])sleep\s+(\d+(?:\.\d+)?)\s*([smhd]?)\b/gi;
  let m;
  let maxSecs = 0;
  while ((m = re.exec(deQuoted)) !== null) {
    const n = parseFloat(m[2]);
    if (Number.isNaN(n)) continue;
    const unit = (m[3] || 's').toLowerCase();
    const mult = unit === 'm' ? 60 : unit === 'h' ? 3600 : unit === 'd' ? 86400 : 1;
    const secs = n * mult;
    if (secs > maxSecs) maxSecs = secs;
  }
  return maxSecs > 0 ? maxSecs : null;
}

const LONG_SLEEP_THRESHOLD_S = 10; // > a few seconds; foreground only.

export function run(payload, env = process.env) {
  const done = (exit, stdout = '', stderr = '') => ({ exit, stdout, stderr });
  try {
    const m = mode(env);
    if (m === 'off') return done(0);

    // Only act on Bash. (The dispatcher routes only Bash here, but belt-and-
    // suspenders for any standalone / mis-routed invocation.)
    if (payload && payload.tool_name && payload.tool_name !== 'Bash') return done(0);

    const ti = (payload && payload.tool_input) || {};
    const cmd = typeof ti.command === 'string' ? ti.command : '';
    if (!cmd.trim()) return done(0); // nothing to inspect → allow

    const runInBackground = ti.run_in_background === true;
    const deQuoted = stripQuotesAndHeredocs(cmd);

    // run_in_background legitimately hosts long-lived servers (waitress/
    // uvicorn) AND a legitimate background `tail -f` / `watch` for log
    // streaming. When run_in_background is true, the unbounded-follow and
    // infinite-loop family are EXPECTED and must pass — the harness owns the
    // lifecycle. Mass-kill storms AND tight state-file polls are dangerous
    // regardless of background, so they still fire (state-file-poll is NOT here).
    const bgExempt = new Set([
      'while-true', 'poll-sleep-loop',
      'tail-follow', 'watch-cmd', 'get-content-wait',
    ]);
    // Evaluate structural rules. Most scan the de-quoted view (so a token inside
    // a string/heredoc can't false-trip); rules flagged scanRaw scan the raw
    // command (their signature lives inside a quoted argument, e.g. taskkill /FI).
    let hit = null;
    for (const rule of buildRules()) {
      if (runInBackground && bgExempt.has(rule.id)) continue;
      const haystack = rule.scanRaw ? cmd : deQuoted;
      if (rule.re.test(haystack)) { hit = rule; break; }
    }

    // Long foreground sleep (only when NOT backgrounded).
    if (!hit && !runInBackground) {
      const secs = longForegroundSleepSeconds(deQuoted);
      if (secs != null && secs > LONG_SLEEP_THRESHOLD_S) {
        hit = {
          id: 'long-foreground-sleep',
          why: `long foreground sleep (${secs}s > ${LONG_SLEEP_THRESHOLD_S}s)`,
          fix: 'A long foreground sleep blocks the session with no operator to interrupt it. If you are waiting on a background job, set run_in_background:true and check status on a later turn instead of sleeping in the foreground.',
        };
      }
    }

    if (!hit) return done(0); // no positive match → ALLOW (fail-open default)

    const notice = [
      `PRISM BASH HANG-GUARD: this command is blocked — ${hit.why}.`,
      `Under Claude Code there is no operator to Ctrl-C a hang, so it wedges the whole session.`,
      `Fix: ${hit.fix}`,
      `Override (use sparingly): set PRISM_BASH_HANG_GUARD=soft (advisory) or =off (pass-through).`,
    ].join('\n');

    appendLog({
      event: 'bash_hang_guard',
      ts: new Date().toISOString(),
      session_id: (payload && payload.session_id) || 'anon',
      rule: hit.id,
      run_in_background: runInBackground,
      blocked: m === 'hard',
      mode: m,
    });

    if (m === 'hard') {
      return done(2, JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: notice,
        },
      }), notice);
    }
    // soft mode: advisory only.
    return done(0, JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: notice },
    }));
  } catch {
    return done(0); // FAIL OPEN on any internal error.
  }
}

// Standalone shim — preserves the wire behavior + parse-error fail-open.
const invokedDirectly = process.argv[1] && basename(process.argv[1]) === 'prism-bash-hang-guard.mjs';
if (invokedDirectly) {
  let payload = {};
  try { payload = JSON.parse(readFileSync(0, 'utf-8') || '{}'); } catch { process.exit(0); }
  try {
    const r = run(payload);
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(r.exit || 0);
  } catch { process.exit(0); }
}
