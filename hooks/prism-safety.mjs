#!/usr/bin/env node
// PRISM Safety Gate — blocks dangerous Bash commands via PreToolUse
import{readFileSync}from'fs';
// v5.7: dual-mode. run(input) returns {exit, stdout, stderr} for the consolidated
// PreToolUse dispatcher; the standalone shim at the bottom preserves the original
// stdin→stdout/stderr→exit wire behavior (byte-identical, verified by golden-master).
export function run(input) {
const out = {s: '', e: ''};
const write = (x) => { out.s += x; };
const ewrite = (x) => { out.e += x; };
const done = (code) => ({exit: code, stdout: out.s, stderr: out.e});
try{
const cmd=(input.tool_input&&input.tool_input.command)||'';

// v5.0 stress-test finding #6 — OVER-FIRE. The gate used to substring-scan the
// RAW command, so a dangerous token inside a QUOTED argument / JSON data
// (git commit -m "stop using rm -rf", echo '{"x":"rm -rf /"}', grep -r "rm -rf")
// tripped it — it blocked measurement commands that only MENTION the token.
// Fix: scan a de-quoted view for shell-command dangers. Two carve-outs keep the
// gate from ever UNDER-blocking:
//   blockedRaw — SQL is normally RUN as a quoted arg (psql -c "DROP TABLE x"),
//     so DROP/TRUNCATE are always scanned RAW; de-quoting would let a real DROP
//     through.
//   eval-wrapper — bash -c "...", python -c "...", node -e, eval … make the
//     quoted text itself executable, so when one is present the shell-danger
//     patterns are also scanned RAW (quotes NOT stripped).

// Scanned against the RAW command always (quoted is the normal invocation form).
const blockedRaw=[
  [/DROP\s+(TABLE|DATABASE|SCHEMA)/i, 'DROP statement blocked by PRISM safety gate'],
  [/TRUNCATE\s+TABLE/i, 'TRUNCATE TABLE blocked by PRISM safety gate'],
];

// Shell-command-position dangers — scanned against the de-quoted view unless an
// eval-wrapper is present.
const blockedCmd=[
  // NOTE: `rm -rf` is handled by the target-aware rmRfDanger() check below — it
  // ALLOWS a specific relative subdir (routine `rm -rf ./build` / `node_modules`)
  // but BLOCKS root / ~ / $VAR / glob / parent-traversal / absolute / bare
  // targets (UAT-4, 2026-06-02). The old blanket regex blocked ALL rm -rf.
  // recursive/force rm onto traversal or SYSTEM paths. `~` (the user's OWN home)
  // dropped from the path class: a non-recursive `rm -f ~/file` is routine
  // cleanup, and recursive home removal is already caught by the rm -rf rule.
  [/rm\s+(-[a-z]*f[a-z]*\s).*(\.\.|\/home|\/etc)/i, 'Destructive rm on important path'],
  [/git\s+push\s+.*--force/i, 'Force push blocked by PRISM safety gate'],
  [/mkfs\./i, 'Filesystem format blocked'],
  [/dd\s+if=.*of=\/dev/i, 'dd to device blocked'],
  // v5.x FIX-D: pipe-to-shell (curl/wget … | bash) — a common remote-code-exec
  // footgun the gate previously missed (v5.0 stress-test finding SAF-002).
  [/\b(curl|wget|fetch)\b[^|;&]*\|\s*(sudo\s+)?(bash|sh|zsh|fish|dash|python[0-9.]*|node|perl|ruby)\b/i, 'pipe-to-shell (curl|bash) blocked by PRISM safety gate (If the token only appears inside quoted TEXT you are passing as data — e.g. a claude -p prompt — put the text in a file and pass it via stdin.)'],
];

// An eval-wrapper makes quoted text executable → scan RAW so quoting can't hide
// a real command. Shells with -c/-lc, interpreters with -c/-e, or a bare `eval`.
const hasEvalWrapper =
  /\b(?:bash|sh|zsh|dash|ksh|fish|ash)\b[^\n]*?\s-[a-z]*c\b/i.test(cmd) ||
  /\b(?:python[0-9.]*|node|perl|ruby|php)\b[^\n]*?\s-[a-z]*[ce]\b/i.test(cmd) ||
  // a shell/interpreter reading a heredoc (or stdin) EXECUTES it → scan RAW
  /\b(?:bash|sh|zsh|dash|ksh|fish|ash|python[0-9.]*|node|perl|ruby|php)\b[^\n|]*?<<-?\s*['"]?\w/i.test(cmd) ||
  /\beval\b/i.test(cmd);
// A heredoc fed to cat/git/etc. is DATA, not a command — strip its whole body
// before scanning so a dangerous token (or embedded quotes that break "..."
// pairing) inside a commit message can't trip the gate. Shell-EXECUTED heredocs
// are caught by hasEvalWrapper above and scanned RAW instead.
function stripHeredocs(s){
  return s.replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n[ \t]*\2(?=\s|$)/g, ' ');
}
const cmdScan = hasEvalWrapper ? cmd : stripHeredocs(cmd).replace(/'[^']*'|"[^"]*"/g, ' ');

for(const [pattern, reason] of blockedRaw){
  if(pattern.test(cmd)){
    ewrite(reason);
    return done(2);
  }
}
for(const [pattern, reason] of blockedCmd){
  if(pattern.test(cmdScan)){
    ewrite(reason);
    return done(2);
  }
}

// UAT-4: target-aware `rm -rf`. Allow a specific relative subdirectory (routine
// cleanup like `rm -rf ./build` or `rm -rf node_modules`); block dangerous or
// unverifiable targets — root, ~, $VAR expansion, glob, parent-traversal,
// absolute/system paths, or a bare `rm -rf` with no operand. Runs on cmdScan
// (de-quoted unless an eval-wrapper is present, same as the rules above).
function rmRfTargetDangerous(t){
  if(!t) return true;                          // bare / de-quoted-to-empty → can't verify
  if(t.startsWith('-')) return true;           // another flag, no clear operand
  t=t.replace(/^["']+|["']+$/g,'');            // strip quote residue
  if(!t) return true;
  if(/[~*$]/.test(t)) return true;             // home, glob, env-var expansion
  if(t.startsWith('/')) return true;           // absolute (system risk)
  if(/(^|\/)\.\.(\/|$)/.test(t)) return true;  // parent traversal
  if(t==='.'||t==='./') return true;           // current working directory
  return false;                                // a specific relative path → safe
}
function rmRfDanger(s){
  const re=/\brm\b((?:\s+-[a-zA-Z]+)*)(?:\s+([^\s;|&<>]*))?/g;
  let m;
  while((m=re.exec(s))!==null){
    const flags=m[1]||'';
    const hasR=/-[a-z]*r/i.test(flags);
    const hasF=/-[a-z]*f/i.test(flags);
    if(hasR&&hasF&&rmRfTargetDangerous(m[2]||'')) return true;
    if(re.lastIndex===m.index) re.lastIndex++;  // guard against zero-width match
  }
  return false;
}
if(rmRfDanger(cmdScan)){
  ewrite('rm -rf blocked by PRISM safety gate (dangerous/unverifiable target) (If the token only appears inside quoted TEXT you are passing as data — e.g. a claude -p prompt — put the text in a file and pass it via stdin.)');
  return done(2);
}

// Warning patterns — allow but add context (Claude sees stdout)
const warned=[
  [/git\s+push\s+(origin\s+)?(main|master|production)/i, 'PRISM WARNING: Pushing to protected branch. Verify this is intentional.'],
];
for(const [pattern, reason] of warned){
  if(pattern.test(cmd)){
    write(JSON.stringify({additionalContext:reason}));
  }
}

return done(0);
} catch {
  // v2.8.0: fail-open on parse error. Was `exit(1)` with stderr "Safety hook
  // error: <msg>" which surfaced to user on every malformed PreToolUse payload.
  // Other PRISM hooks all exit 0 silently on bad input; this one was
  // inconsistent. The only intentional error path is exit 2 above (dangerous
  // pattern matched).
  return done(0);
}
}

// Standalone shim — preserves original wire behavior + the parse-error fail-open.
import {basename} from 'path';
if (process.argv[1] && basename(process.argv[1]) === 'prism-safety.mjs') {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf-8')); } catch { process.exit(0); }
  const r = run(input);
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.exit || 0);
}
