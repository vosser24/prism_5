#!/usr/bin/env node
// PRISM Safety Gate — blocks dangerous Bash commands via PreToolUse
import{readFileSync}from'fs';
try{
const input=JSON.parse(readFileSync(0,'utf-8'));
const cmd=(input.tool_input&&input.tool_input.command)||'';

// Dangerous patterns to BLOCK (exit 2)
const blocked=[
  [/rm\s+-rf\s/i, 'rm -rf blocked by PRISM safety gate'],
  [/rm\s+(-[a-z]*f[a-z]*\s).*(\.\.|\/home|\/etc|~)/i, 'Destructive rm on important path'],
  [/DROP\s+(TABLE|DATABASE|SCHEMA)/i, 'DROP statement blocked by PRISM safety gate'],
  [/TRUNCATE\s+TABLE/i, 'TRUNCATE TABLE blocked by PRISM safety gate'],
  [/git\s+push\s+.*--force/i, 'Force push blocked by PRISM safety gate'],
  [/mkfs\./i, 'Filesystem format blocked'],
  [/dd\s+if=.*of=\/dev/i, 'dd to device blocked'],
];

for(const [pattern, reason] of blocked){
  if(pattern.test(cmd)){
    process.stderr.write(reason);
    process.exit(2);
  }
}

// Warning patterns — allow but add context (Claude sees stdout)
const warned=[
  [/git\s+push\s+(origin\s+)?(main|master|production)/i, 'PRISM WARNING: Pushing to protected branch. Verify this is intentional.'],
];
for(const [pattern, reason] of warned){
  if(pattern.test(cmd)){
    process.stdout.write(JSON.stringify({additionalContext:reason}));
  }
}

process.exit(0);
} catch {
  // v2.8.0: fail-open on parse error. Was `exit(1)` with stderr "Safety hook
  // error: <msg>" which surfaced to user on every malformed PreToolUse payload.
  // Other PRISM hooks all exit 0 silently on bad input; this one was
  // inconsistent. The only intentional error path is exit 2 above (dangerous
  // pattern matched).
  process.exit(0);
}
