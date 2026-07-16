#!/usr/bin/env node
// PRISM ConfigChange — warns when CLAUDE.md is modified unexpectedly
// Fires when any config file (CLAUDE.md, .claude/rules/*.md) changes
import{readFileSync as r,existsSync as e,appendFileSync as a,mkdirSync as m}from'fs';
import{join as j}from'path';
try{
const input=JSON.parse(r(0,'utf-8'));
const H=process.env.HOME||process.env.USERPROFILE;
const globalClaude=j(H,'.claude','CLAUDE.md');
// Event-keyed routing-log record (census visibility). Additive, fail-open.
const log=(warned)=>{try{m(j(H,'.claude'),{recursive:true});a(j(H,'.claude','.prism-routing.jsonl'),JSON.stringify({event:'config_guard',ts:new Date().toISOString(),session_id:input.session_id||'anon',warned})+'\n');}catch{}};

// Check if global CLAUDE.md still has PRISM section
if(e(globalClaude)){
  const content=r(globalClaude,'utf-8');
  if(!content.includes('## PRISM')){
    log(true);
    process.stdout.write('PRISM WARNING: Global CLAUDE.md no longer contains ## PRISM section. It may have been overwritten by a plugin or tool. Run: node tools/prism-installer.mjs install to restore.');
  }else{
    log(false);
  }
}
}catch{}
process.exit(0);
