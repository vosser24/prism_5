#!/usr/bin/env node
// PRISM SubagentStop — roster update + spend ledger append (Gap 6).
// Fires after every subagent completion.
import{readFileSync as r,writeFileSync as w,appendFileSync as ap,existsSync as e,mkdirSync as mk}from'fs';
import{join as j}from'path';
import{pathToFileURL}from'url';
import{basename}from'path';
import{withRosterLock}from'../tools/lib/prism-roster-lock.mjs';
import{prismHome}from'./lib/prism-home.mjs';

export async function run(payload) {
const input = payload;
const H=prismHome();
const agentName=(input.agent_name||input.agent||'').replace(/^@/,'');
const project=(process.cwd().split(/[/\\]/).pop())||'unknown';
const sessionId=input.session_id||'';
const model=input.model||input.subagent_model||'';
const usage=input.usage||{};
const tokens=(usage.input_tokens||0)+(usage.output_tokens||0)+(usage.cache_creation_input_tokens||0)+(usage.cache_read_input_tokens||0);

// ── Roster update (existing behavior, wrapped so its failure can't block ledger) ──
const rp=j(H,'.claude','skills','prism-plan','references','roster.json');
if(e(rp)&&agentName&&!['master-orchestrator','agent-factory','prism-updater'].includes(agentName)){
  // E-P5: cheap lock-free pre-read to check if agentName is registered.
  // Avoids acquiring the lock + parsing + writing for every unregistered subagent
  // (Explore, Plan, Haiku mappers, etc.) that would no-op the inner write guard.
  let agentKnown=false;
  try{const preread=JSON.parse(r(rp,'utf-8'));agentKnown=!!(preread.agents&&preread.agents[agentName]);}catch{}
  if(agentKnown){
    try{
      // Locked read-modify-write: under the SubagentStop dispatcher's Promise.all
      // this races phase-1-5-oob's locked roster write. withRosterLock serialises
      // them so neither increment is lost.
      await withRosterLock(rp, async () => {
        const roster=JSON.parse(r(rp,'utf-8'));
        if(roster.agents&&roster.agents[agentName]){
          const a=roster.agents[agentName];
          a.total_tasks_completed=(a.total_tasks_completed||0)+1;
          a.last_used=new Date().toISOString();
          a.projects_worked=a.projects_worked||[];
          const p=a.projects_worked.find(x=>x.name===project);
          if(p){p.tasks_completed++;p.date=a.last_used}
          else a.projects_worked.push({name:project,date:a.last_used,tasks_completed:1});
          roster.last_updated=new Date().toISOString();
          w(rp,JSON.stringify(roster,null,2));
        }
      });
    }catch{}
  }
}

// ── Spend ledger append (Gap 6) ──
const PRICE={
  'opus-4':[15,75,18.75,1.5],'opus-4-6':[15,75,18.75,1.5],'opus-4-7':[15,75,18.75,1.5],
  'sonnet-4':[3,15,3.75,0.3],'sonnet-4-5':[3,15,3.75,0.3],'sonnet-4-6':[3,15,3.75,0.3],
  'haiku-4':[1,5,1.25,0.1],'haiku-4-5':[1,5,1.25,0.1],
};
const mkModel=(m)=>{if(!m)return'';const p=m.replace('claude-','').split('-');if(p.length&&/^\d{8}$/.test(p[p.length-1]))p.pop();return p.join('-');};
const k=mkModel(model);
let cost=0;
if(PRICE[k]){
  const[ip,op,cw,cr]=PRICE[k];
  cost=(usage.input_tokens||0)*ip/1e6+(usage.output_tokens||0)*op/1e6+(usage.cache_creation_input_tokens||0)*cw/1e6+(usage.cache_read_input_tokens||0)*cr/1e6;
}
try{
  mk(j(H,'.claude'),{recursive:true});
  const row={
    ts:new Date().toISOString(),
    session_id:sessionId,
    project,
    agent:agentName||'unknown',
    model:model||'unknown',
    tokens,
    cost_usd:Number(cost.toFixed(6)),
  };
  ap(j(H,'.claude','.prism-spend.jsonl'),JSON.stringify(row)+'\n');
  // Phase 4 dual-write: mirror row into SQLite ledger for analytical queries.
  try{
    const mod = await import(pathToFileURL(j(H,'.claude','tools','prism-db.mjs')).href);
    const db = mod.openDb();
    mod.appendSpend(db, row);
    mod.close(db);
  }catch{}
}catch{}
return {exit: 0};
}

// Guard: only run as hook when invoked directly, NOT when imported by tests.
const invokedDirectly = process.argv[1] && basename(process.argv[1]) === 'prism-subagent-stop.mjs';
if (invokedDirectly) {
  (async () => {
    try {
      const input = JSON.parse(r(0,'utf-8'));
      await run(input);
    } catch {}
    process.exit(0);
  })();
}
