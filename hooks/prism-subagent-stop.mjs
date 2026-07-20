#!/usr/bin/env node
// PRISM SubagentStop — roster update + spend ledger append (Gap 6).
// Fires after every subagent completion.
import{readFileSync as r,writeFileSync as w,appendFileSync as ap,existsSync as e,mkdirSync as mk}from'fs';
import{join as j}from'path';
import{pathToFileURL}from'url';
import{basename}from'path';
import{withRosterLock}from'../tools/lib/prism-roster-lock.mjs';
import{prismHome}from'./lib/prism-home.mjs';
import{appendRecord as appendLiveAgentRecord,extractAgentKey}from'./lib/prism-live-agents.mjs';

export async function run(payload) {
const input = payload;
const H=prismHome();
// Resolve the subagent identifier from the payload.
// SubagentStop payloads carry the agent identity in `agent_type` (canonical,
// per https://code.claude.com/docs/en/hooks — "Agent name … present when the hook
// fires inside a subagent").  Older/internal paths also surface it as
// `subagent_type` (the Agent() tool_input field echoed back), `agent_name`, or
// `agent`.  Read all four in priority order so dispatched specialists that arrive
// only as `agent_type:'claude-master'` are not silently dropped.
const rawName=(input.agent_type||input.subagent_type||input.agent_name||input.agent||'').trim().replace(/^@/,'');
// Normalised lowercase for roster-key comparison (roster keys are all lowercase-kebab).
const normName=rawName.toLowerCase();
// resolveAgentName: return the exact roster key that matches rawName or normName.
// Primary: exact match on rawName (preserves intent and is cheap).
// Fallback: case-insensitive match on normName (handles subagent_type casing drift).
// Never throws — wrapped below.
function resolveAgentName(rosterAgents){
  if(!rosterAgents||typeof rosterAgents!=='object')return rawName||'';
  if(rawName&&Object.prototype.hasOwnProperty.call(rosterAgents,rawName))return rawName;
  if(normName&&normName!==rawName){
    for(const k of Object.keys(rosterAgents)){if(k.toLowerCase()===normName)return k;}
  }
  return rawName||'';
}
// Initial agentName: exact-key resolution requires the roster, use rawName for
// the pre-check read below; the locked write re-resolves against fresh roster data.
const agentName=rawName;
const project=(process.cwd().split(/[/\\]/).pop())||'unknown';
const sessionId=input.session_id||'';
const model=input.model||input.subagent_model||'';
const usage=input.usage||{};
const tokens=(usage.input_tokens||0)+(usage.output_tokens||0)+(usage.cache_creation_input_tokens||0)+(usage.cache_read_input_tokens||0);

// ── F1 Layer C: SubagentStop telemetry event (the discovery instrument for F1-B/F2) ──
// Previously run() updated roster/spend/live-agents but NEVER appended a routing
// event, so worker-stall (#56) was unmeasurable and no SubagentStop telemetry
// existed at all. Append ONE line per stop, reusing the appendFileSync pattern
// below. When PRISM_DEBUG_SUBAGENT_PAYLOAD=1, also record the payload key NAMES
// (Object.keys — names only, no values; bounded, no privacy leak) to discover the
// real live payload shape for the identity/transcript plumbing R2 depends on.
// Fail-open: a telemetry failure must never throw or disturb the logic below.
try{
  const ts=new Date().toISOString();
  const ev={event:'subagent_stop',ts,session_id:sessionId,agent:rawName||'unknown',model:model||'unknown',tokens};
  if(process.env.PRISM_DEBUG_SUBAGENT_PAYLOAD==='1')ev.payload_keys=Object.keys(input||{});
  mk(j(H,'.claude'),{recursive:true});
  ap(j(H,'.claude','.prism-routing.jsonl'),JSON.stringify(ev)+'\n');
}catch{}

// ── F1 Layer B: holding-string final-output DETECTOR (UAT #56) ──
// A dispatched worker whose FINAL assistant message is a "holding string"
// ("I'll hold here and wait for the background notification…", "verifying…
// will report back", "the child is checking…") is a FAILED/orphaned result —
// currently invisible. Primary source: input.last_assistant_message (the
// measured live SubagentStop payload always carries this). Fallback: a
// bounded tail of the transcript file, kept minimal and fail-open. Advisory
// only — never throws, never disturbs roster/spend/live-agents logic below.
try{
  let finalMsg = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '';
  if (!finalMsg) {
    // Minimal fail-open fallback: bounded tail read of the transcript.
    try{
      const tp = input.transcript_path || input.agent_transcript_path;
      if (tp && e(tp)) {
        const buf = r(tp, 'utf-8');
        const tail = buf.length > 4096 ? buf.slice(-4096) : buf;
        const lines = tail.split('\n').filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          try{
            const obj = JSON.parse(lines[i]);
            const msg = obj && obj.message;
            const content = msg && msg.content;
            if (msg && msg.role === 'assistant' && content) {
              if (typeof content === 'string') { finalMsg = content; break; }
              if (Array.isArray(content)) {
                const t = content.filter(c => c && c.type === 'text').map(c => c.text).join('\n');
                if (t) { finalMsg = t; break; }
              }
            }
          }catch{}
        }
      }
    }catch{}
  }
  if (finalMsg && typeof finalMsg === 'string') {
    const trimmed = finalMsg.trim();
    const newlineCount = (trimmed.match(/\n/g) || []).length;
    const HOLDING_RE = /\b(verifying|waiting for (?:the |a |an )?(?:background|notification|confirmation|response|reply|result|results|child|worker|subagent|agent|callback|signal|completion|it\b|them\b)|will (report|check) back|the child is|holding (here|until)|hold here|standing by|background notification)\b/i;
    if (trimmed.length > 0 && trimmed.length < 400 && newlineCount < 3 && HOLDING_RE.test(trimmed)) {
      const ts = new Date().toISOString();
      const hev = { event: 'holding_string_final', ts, session_id: sessionId, agent: rawName || 'unknown' };
      mk(j(H,'.claude'),{recursive:true});
      ap(j(H,'.claude','.prism-routing.jsonl'), JSON.stringify(hev) + '\n');
      process.stderr.write(`[prism-subagent-stop] HOLDING-STRING final message from '${rawName || 'unknown'}' — likely a stalled/orphaned worker; treat as FAILED result.\n`);
    }
  }
}catch{}

// ── Roster update (existing behavior, wrapped so its failure can't block ledger) ──
const rp=j(H,'.claude','skills','prism-plan','references','roster.json');
if(e(rp)&&agentName&&!['master-orchestrator','agent-factory','prism-updater'].includes(agentName)){
  // E-P5 + name-resolution fix: cheap lock-free pre-read.
  // resolveAgentName checks exact-case then lowercase-normalised so a payload like
  // {agent_type:'claude-master'} (canonical SubagentStop field) correctly resolves
  // to roster key 'claude-master'. Lock is only acquired when the key is confirmed.
  let resolvedKey='';
  try{
    const preread=JSON.parse(r(rp,'utf-8'));
    const k=resolveAgentName(preread.agents||{});
    if(k&&preread.agents&&preread.agents[k])resolvedKey=k;
  }catch{}
  if(resolvedKey){
    try{
      // Locked read-modify-write: under the SubagentStop dispatcher's Promise.all
      // this races phase-1-5-oob's locked roster write. withRosterLock serialises
      // them so neither increment is lost.
      await withRosterLock(rp, async () => {
        const roster=JSON.parse(r(rp,'utf-8'));
        // Re-resolve inside the lock in case the file changed since the pre-read.
        const key=resolveAgentName(roster.agents||{});
        if(roster.agents&&key&&roster.agents[key]){
          const a=roster.agents[key];
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
  'opus-4':[5,25,6.25,0.5],'opus-4-6':[5,25,6.25,0.5],'opus-4-7':[5,25,6.25,0.5],'opus-4-8':[5,25,6.25,0.5],
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

// ── Package E: live-agents ledger — record completion (anti-confabulation) ──
// ADDITIVE (does not disturb roster/spend behavior above): append a
// {agentId, status:'completed'} record to the session-scoped ledger. The ledger
// key is now the shared per-instance extractAgentKey(input) (agent_id when the
// payload carries one, else the type — same resolver SubagentStart uses), so
// this Stop record reconciles against the SubagentStart `running` record for the
// SAME instance rather than colliding with other concurrent agents of the same
// type. rawName (the type) is preserved separately as agentType. Fail-open: no
// session_id / no rawName / any error → skip silently.
try{
  if(sessionId&&rawName){
    const liveKey = extractAgentKey(input);
    appendLiveAgentRecord(H, sessionId, {
      agentId: liveKey,
      agentType: rawName,
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
  }
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
