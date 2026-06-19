#!/usr/bin/env node
// PRISM Agent Quality Gate (v1.0.0) — PostToolUse on {Write, Edit, MultiEdit}.
//
// Fires on a write to `.../.claude/agents/<name>.md` — the SAME identity-bearing
// signal prism-agent-write-register uses (AGENT_RE) — and scores the just-written
// agent against the domain rubric (skills wired+verified, research-tier-by-role,
// domain-depth refs). The score is written by THIS hook to a path the agent does
// NOT control (defeats the "factory grades its own homework" theater problem).
//
// WHY this event and not PostToolUse:Agent: the Agent payload only says
// agent-factory ran; the Write payload carries file_path → the agent's identity
// and scope. Reuses agent-write-register's path-matching exactly.
//
// PostToolUse CANNOT block (the write already happened). So:
//   off:      no-op.
//   advisory: write scorecard + emit the gap list as additionalContext. DEFAULT.
//   enforce:  same, but for a FAILING role:builder agent the message is escalated
//             ("NOT production-ready — remediate or waive") and a not-ready signal
//             is recorded in the scorecard. (No deny — PostToolUse can't.)
//
// FAIL-OPEN: any throw → exit 0, no output. A gate bug must never wedge a write.
//
// Off-switch: PRISM_AGENT_QUALITY=off. Tri-state: off|advisory|enforce.

import {readFileSync, existsSync, writeFileSync, mkdirSync, renameSync, appendFileSync} from 'node:fs';
import {join, dirname, sep, basename} from 'node:path';
import {scoreAgent} from './lib/prism-agent-quality.mjs';

const H = process.env.USERPROFILE || process.env.HOME || '';
const GLOBAL_ROSTER = join(H, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');
const SKILL_DOMAIN_MAP = join(H, '.claude', 'skills', 'prism-plan', 'references', 'skill-domain-map.json');
const SCORECARD_DIR = join(H, '.claude', '.prism-quality');
const LOG_PATH = join(H, '.claude', '.prism-routing.jsonl');
const MODE_RAW = String(process.env.PRISM_AGENT_QUALITY || 'advisory').toLowerCase();
const MODE = ['off', 'advisory', 'enforce'].includes(MODE_RAW) ? MODE_RAW : 'advisory';

// Same matcher as prism-agent-write-register.mjs:37 — `.../.claude/agents/<name>.md`.
const AGENT_RE = /[/\\]\.claude[/\\]agents[/\\]([^/\\]+)\.md$/i;

function collectPaths(ti) {
  const out = new Set();
  if (!ti) return [...out];
  if (typeof ti.file_path === 'string') out.add(ti.file_path);
  if (Array.isArray(ti.edits)) for (const e of ti.edits) { if (e && typeof e.file_path === 'string') out.add(e.file_path); }
  return [...out];
}
function isAgentPath(p) {
  if (!p || typeof p !== 'string') return false;
  if (p.endsWith('roster.json')) return false;
  return AGENT_RE.test(p);
}
function agentName(p) { const m = p.match(AGENT_RE); return m ? m[1] : null; }

function readJson(path) {
  try { if (!existsSync(path)) return null; return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}
function rosterForPath(agentPath) {
  // Global agent → global roster; else the project roster beside it.
  const normalised = agentPath.split(/[\\/]/).join(sep);
  const expectedGlobal = join(H, '.claude', 'agents') + sep;
  if (normalised.startsWith(expectedGlobal)) return readJson(GLOBAL_ROSTER);
  return readJson(join(dirname(agentPath), 'roster.json'));
}
function writeScorecardAtomic(name, card) {
  try {
    mkdirSync(SCORECARD_DIR, {recursive: true});
    const p = join(SCORECARD_DIR, `${name}.json`);
    const tmp = p + '.tmp.' + process.pid;
    writeFileSync(tmp, JSON.stringify(card, null, 2) + '\n');
    try { renameSync(tmp, p); } catch { writeFileSync(p, JSON.stringify(card, null, 2) + '\n'); }
  } catch {}
}
function appendLog(obj) {
  try { mkdirSync(dirname(LOG_PATH), {recursive: true}); appendFileSync(LOG_PATH, JSON.stringify(obj) + '\n'); } catch {}
}

export async function run(payload) {
  // PostToolUse dispatcher concatenates raw stdout from every Write-route hook
  // (it does NOT JSON-merge like the PreToolUse one), so emit PLAIN TEXT — matching
  // prism-agent-write-register / prism-kb-autosync. Never JSON here.
  const allow = (ctx) => ({exit: 0, stdout: ctx || '', stderr: ''});
  try {
    if (MODE === 'off') return allow('');
    if (!payload || !['Write', 'Edit', 'MultiEdit'].includes(payload.tool_name)) return allow('');

    const paths = collectPaths(payload.tool_input).filter(isAgentPath);
    if (!paths.length) return allow('');

    const skillDomainMap = readJson(SKILL_DOMAIN_MAP) || {};
    const messages = [];

    for (const p of paths) {
      const name = agentName(p);
      if (!name) continue;
      // Read the file that was just written (PostToolUse runs after the write).
      let text = '';
      try { text = readFileSync(p, 'utf-8'); } catch { continue; }

      const roster = rosterForPath(p);
      const card = scoreAgent({name, text, roster, skillDomainMap});
      const scorecard = {
        ...card,
        ts: new Date().toISOString(),
        agent_path: p,
        mode: MODE,
        not_ready: MODE === 'enforce' && card.role === 'builder' && !card.pass,
      };
      writeScorecardAtomic(name, scorecard);
      appendLog({event: 'agent_quality_gate', ts: scorecard.ts, agent: name, role: card.role, domain: card.domain, quality_score: card.quality_score, pass: card.pass, mode: MODE, gaps: card.gaps.length});

      if (card.pass || !card.gaps.length) continue; // silent on a passing/low-bar agent

      const head = (MODE === 'enforce' && card.role === 'builder')
        ? `PRISM AGENT QUALITY GATE (enforce): '${name}' (role=builder, domain=${card.domain}) is NOT production-ready (quality_score ${card.quality_score}/5). Remediate before relying on it for production builds, or record an explicit skills_wired/waiver justification.`
        : `PRISM AGENT QUALITY GATE: '${name}' (role=${card.role}, domain=${card.domain}) scored ${card.quality_score}/5 — under-equipped vs available resources.`;
      messages.push(`${head}\nGaps:\n- ${card.gaps.join('\n- ')}\nScorecard: ~/.claude/.prism-quality/${name}.json`);
    }

    return allow(messages.join('\n\n'));
  } catch {
    return allow('');
  }
}

// Standalone shim — parse-error fail-open.
if (process.argv[1] && basename(process.argv[1]) === 'prism-agent-quality-gate.mjs') {
  let payload;
  try { payload = JSON.parse(readFileSync(0, 'utf-8') || '{}'); } catch { process.exit(0); }
  run(payload).then((r) => {
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(r.exit || 0);
  }).catch(() => process.exit(0));
}
