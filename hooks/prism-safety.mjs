#!/usr/bin/env node
// ATLAS Safety Gate — blocks dangerous Bash commands via PreToolUse
import{readFileSync}from'fs';
try{
const input=JSON.parse(readFileSync(0,'utf-8'));
const cmd=(input.tool_input&&input.tool_input.command)||'';

// Dangerous patterns to BLOCK (exit 2)
const blocked=[
  [/rm\s+-rf\s/i, 'rm -rf blocked by ATLAS safety gate'],
  [/rm\s+(-[a-z]*f[a-z]*\s).*(\.\.|\/home|\/etc|~)/i, 'Destructive rm on important path'],
  [/DROP\s+(TABLE|DATABASE|SCHEMA)/i, 'DROP statement blocked by ATLAS safety gate'],
  [/TRUNCATE\s+TABLE/i, 'TRUNCATE TABLE blocked by ATLAS safety gate'],
  [/git\s+push\s+.*--force/i, 'Force push blocked by ATLAS safety gate'],
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
  [/git\s+push\s+(origin\s+)?(main|master|production)/i, 'ATLAS WARNING: Pushing to protected branch. Verify this is intentional.'],
];
for(const [pattern, reason] of warned){
  if(pattern.test(cmd)){
    process.stdout.write(JSON.stringify({additionalContext:reason}));
  }
}

process.exit(0);
}catch(err){process.stderr.write('Safety hook error: '+err.message);process.exit(1);}
