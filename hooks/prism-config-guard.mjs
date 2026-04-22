#!/usr/bin/env node
// ATLAS ConfigChange — warns when CLAUDE.md is modified unexpectedly
// Fires when any config file (CLAUDE.md, .claude/rules/*.md) changes
import{readFileSync as r,existsSync as e}from'fs';
import{join as j}from'path';
try{
const input=JSON.parse(r(0,'utf-8'));
const H=process.env.HOME||process.env.USERPROFILE;
const globalClaude=j(H,'.claude','CLAUDE.md');

// Check if global CLAUDE.md still has ATLAS section
if(e(globalClaude)){
  const content=r(globalClaude,'utf-8');
  if(!content.includes('## ATLAS')){
    process.stdout.write('ATLAS WARNING: Global CLAUDE.md no longer contains ## ATLAS section. It may have been overwritten by a plugin or tool. Run: python atlas-v2.py to restore.');
  }
}
}catch{}
process.exit(0);
