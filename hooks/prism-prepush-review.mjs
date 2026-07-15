#!/usr/bin/env node
// PRISM PreToolUse[Bash] pre-push review nudge (v4.1 Phase A Q4).
//
// When the Bash command about to run is a git push (and the optional
// gate-mode flag isn't present), return permissionDecision: "ask" plus
// additionalContext telling the user/Claude to run /code-review and
// /security-review first.
//
// This is a NUDGE, not a hard gate. Per D005's verified matrix,
// PreToolUse supports both permissionDecision and additionalContext, so
// the harness will surface the ask prompt to the user and inject the
// context into the agent's view.
//
// Optional hard-gate mode: if ~/.claude/.prism-flags/review-done__<key>.json
// exists for the current project + branch, skip the ask and let the
// push proceed silently. The flag is written by a future
// PostToolUse[Skill] hook on /code-review completion (out of scope for
// Phase A — gate-mode is opt-in plumbing only).
//
// Off-switch: PRISM_DISABLE_PREPUSH_NUDGE=1 → exit 0 silently.
//
// Output: JSON to stdout matching the PreToolUse decision-control shape:
//   {
//     "hookSpecificOutput": {
//       "hookEventName": "PreToolUse",
//       "permissionDecision": "ask",
//       "permissionDecisionReason": "<text>"
//     },
//     "additionalContext": "<nudge text>"
//   }
//
// Fail-open: parse errors or any unexpected condition → exit 0, no nudge.

import {readFileSync} from 'fs';
import {spawnSync} from 'child_process';

// v5.7: dual-mode. run(input) returns {exit, stdout, stderr} for the consolidated
// PreToolUse dispatcher; the standalone shim at the bottom preserves the original
// wire behavior (byte-identical, verified by golden-master).
export async function run(input) {
  let out = '';
  const write = (s) => { out += s; };
  const done = (code) => ({exit: code, stdout: out, stderr: ''});
  try {
    if (String(process.env.PRISM_DISABLE_PREPUSH_NUDGE || '') === '1') return done(0);

  const cmd = (input.tool_input && input.tool_input.command) || '';

  // v5.2.11 OVER-FIRE fix (UAT prompt 28, 2026-06-04): match against a de-quoted
  // view, not the RAW command. A `git push` token MENTIONED inside a quoted
  // commit message (`git commit -m '... git push --force ...'`) used to trip the
  // nudge even though no push was happening — the same quoted-token over-fire
  // class prism-safety.mjs already fixed. Stripping heredoc bodies + quoted-arg
  // contents removes the false positive without any false negative: every push
  // the matcher catches sits at an UNQUOTED boundary (start / space / ; / && / ||),
  // so it never lives inside a stripped span (a compound `... && git push` still
  // matches). Pushes hidden inside `bash -c "git push"` were never matched by the
  // boundary class to begin with, so de-quoting changes nothing there.
  const scan = cmd
    .replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n[ \t]*\2(?=\s|$)/g, ' ')  // heredoc bodies
    .replace(/'[^']*'|"[^"]*"/g, ' ');                                  // quoted arg bodies

  // Match git push variants. Conservative — only the canonical forms.
  // We deliberately MISS unusual forms like aliases; Phase A goal is
  // catch the 99% case, not the 100% case.
  if (!/(^|\s|;|&&|\|\|)git\s+(-\S+\s+)*push(\s|$)/i.test(scan)) return done(0);
  // Exclude --dry-run: a preview push doesn't need a code-review gate.
  // Same for --help (e.g., `git push --help` is doc-lookup, not a push).
  // \b doesn't anchor before "--" (dash is non-word and so is space), so use
  // an explicit boundary class.
  if (/(?:^|\s)--dry-run(?:\s|$)/.test(scan)) return done(0);
  if (/(?:^|\s)--help(?:\s|$)/.test(scan)) return done(0);

  const cwd = input.cwd || process.cwd();

  // Compute current branch for gate-mode lookup. Fail-open if not a git
  // repo — the safety hook will warn separately if push-to-main detected.
  let branch = '';
  const br = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd, encoding: 'utf-8', timeout: 3000, windowsHide: true,
  });
  if (br.status === 0) branch = (br.stdout || '').trim();

  // Gate-mode bypass: review-done flag present for THIS branch.
  if (branch) {
    const {listPendingFlags} = await import('../tools/lib/prism-flag-file.mjs');
    const flags = listPendingFlags(cwd);
    const reviewDone = flags.find(
      (f) => f.flag === 'review-done' && f.payload && f.payload.branch === branch
    );
    if (reviewDone) return done(0);
  }

  const reason = branch
    ? `PRISM: about to push branch '${branch}'. Run /code-review and /security-review first; approve here to proceed.`
    : `PRISM: about to push. Run /code-review and /security-review first; approve here to proceed.`;
  const nudge = `PRISM pre-push nudge: any push to a shared remote benefits from /code-review + /security-review against the diff. To bypass this nudge in trusted contexts: set PRISM_DISABLE_PREPUSH_NUDGE=1, or write ~/.claude/.prism-flags/review-done__<key>.json with {branch:'${branch || '<branch>'}'}.`;

  // PreToolUse decision-control: both permissionDecision and additionalContext
  // live inside hookSpecificOutput (matches every other PreToolUse hook in
  // this codebase — see prism-memory-save-nudge / prism-prompt-tier-router).
  write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: reason,
      additionalContext: nudge,
    },
  }));
  } catch {}
  return done(0);
}

// Standalone shim — preserves original wire behavior + parse-error fail-open.
import {basename} from 'path';
if (process.argv[1] && basename(process.argv[1]) === 'prism-prepush-review.mjs') {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf-8')); } catch { process.exit(0); }
  const r = await run(input);
  if (r.stdout) process.stdout.write(r.stdout);
  process.exit(r.exit || 0);
}
