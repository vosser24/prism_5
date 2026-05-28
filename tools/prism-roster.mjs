#!/usr/bin/env node
// PRISM v4.5 — roster management CLI
//
// Subcommands:
//   --apply-ratchet         apply evidence-discipline ratchet from verdict log
//   --reset-model <agent>   manual deescalation reset
//   --tag-1-5 <agent>       set requires_phase_1_5: true
//   --untag-1-5 <agent>     set requires_phase_1_5: false
//   --skip-next-oob <spec>  set skip_next_oob: true on the named agent (auto-cleared after one dispatch)
//
// All writes to roster.json are atomic (tempfile + rename). On --apply-ratchet,
// processes verdict log read-only; only writes roster.json if any change is
// required (no-op friendly).
//
// Threshold rules (v4.4):
//   - UN-CITED rate >= 0.30 over last 10 dispatches -> pending_upgrade=true
//   - UN-CITED rate < 0.10 + pending_upgrade=true + no other ratchet -> no clear (manual review)

import {readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, appendFileSync} from 'fs';
import {join} from 'path';
import {withRosterLock} from './lib/prism-roster-lock.mjs';

const H = process.env.HOME || process.env.USERPROFILE;
const ROSTER = join(H, '.claude', 'skills', 'prism-plan', 'references', 'roster.json');
const VERDICT_LOG = join(H, '.claude', '.prism-phase-1-5-verdicts.jsonl');
const THRESHOLD = 0.30;
const MIN_DISPATCHES = 10;

const args = process.argv.slice(2);
let mode = null;
let agentArg = null;
const seenModes = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--apply-ratchet') { mode = 'apply-ratchet'; seenModes.push(a); }
  else if (a === '--reset-model') { mode = 'reset-model'; agentArg = args[++i]; seenModes.push(a); }
  else if (a === '--tag-1-5') { mode = 'tag-1-5'; agentArg = args[++i]; seenModes.push(a); }
  else if (a === '--untag-1-5') { mode = 'untag-1-5'; agentArg = args[++i]; seenModes.push(a); }
  else if (a === '--skip-next-oob') { mode = 'skip-next-oob'; agentArg = args[++i]; seenModes.push(a); }
  else if (a === '-h' || a === '--help') {
    process.stdout.write(`Usage: prism-roster [--apply-ratchet | --reset-model <agent> | --tag-1-5 <agent> | --untag-1-5 <agent> | --skip-next-oob <spec>]\n`);
    process.exit(0);
  }
}

if (seenModes.length > 1) {
  process.stderr.write(`error: only one subcommand may be passed. Got: ${seenModes.join(', ')}\n`);
  process.exit(2);
}

if (!mode) {
  process.stderr.write('error: missing subcommand. Use --help.\n');
  process.exit(2);
}

function atomicWrite(path, content) {
  try {
    const tmp = path + '.tmp';
    writeFileSync(tmp, content);
    renameSync(tmp, path);
    return true;
  } catch {
    try {
      writeFileSync(path, content);
      return true;
    } catch (e2) {
      process.stderr.write(`error: failed to write ${path}: ${e2 && e2.message}\n`);
      return false;
    }
  }
}

function readRoster() {
  if (!existsSync(ROSTER)) {
    process.stderr.write(`error: roster.json not found at ${ROSTER}\n`);
    process.exit(3);
  }
  try {
    return JSON.parse(readFileSync(ROSTER, 'utf-8'));
  } catch (e) {
    process.stderr.write(`error: roster.json unparseable: ${e.message}\n`);
    process.exit(4);
  }
}

function writeRoster(roster) {
  const ok = atomicWrite(ROSTER, JSON.stringify(roster, null, 2));
  if (!ok) {
    process.stderr.write(`error: roster.json write failed; ratchet changes lost.\n`);
    process.exit(6);
  }
}

function logToImprovements(agent, line) {
  const dir = join(H, '.claude', 'agents', agent, 'lessons');
  const path = join(dir, 'improvements.md');
  try {
    mkdirSync(dir, {recursive: true});
    appendFileSync(path, `\n[${new Date().toISOString()}] ${line}\n`);
  } catch {}
}

if (mode === 'apply-ratchet') {
  if (!existsSync(VERDICT_LOG)) {
    process.stdout.write('No verdict log; nothing to ratchet.\n');
    process.exit(0);
  }
  const entries = readFileSync(VERDICT_LOG, 'utf-8').trim().split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

  const perAgent = {};
  for (const e of entries) {
    const a = String(e.specialist_name || '').replace(/^@/, '');
    if (!a) continue;
    if (!perAgent[a]) perAgent[a] = {dispatches: 0, total_claims: 0, un_cited: 0};
    perAgent[a].dispatches++;
    perAgent[a].total_claims += (e.summary && e.summary.total) || 0;
    perAgent[a].un_cited += ((e.summary && e.summary.un_cited) || 0) + ((e.summary && e.summary.rejected) || 0);
  }

  await withRosterLock(ROSTER, async () => {
    const roster = readRoster();
    let changes = 0;
    for (const [agent, stats] of Object.entries(perAgent)) {
      if (stats.dispatches < MIN_DISPATCHES) continue;
      if (stats.total_claims === 0) continue;
      const rate = stats.un_cited / stats.total_claims;
      if (rate < THRESHOLD) continue;
      if (!roster.agents || !roster.agents[agent]) continue;
      if (roster.agents[agent].pending_upgrade === true) continue;
      roster.agents[agent].pending_upgrade = true;
      roster.agents[agent].status = 'upgrade_needed';
      logToImprovements(agent, `Evidence-discipline ratchet flipped pending_upgrade=true (UN-CITED rate ${(rate * 100).toFixed(1)}% over ${stats.dispatches} dispatches).`);
      process.stdout.write(`Flagged @${agent}: pending_upgrade=true (UN-CITED rate ${(rate * 100).toFixed(1)}%)\n`);
      changes++;
    }

    if (changes > 0) {
      roster.last_updated = new Date().toISOString();
      writeRoster(roster);
      process.stdout.write(`Updated roster.json: ${changes} agent(s) flagged.\n`);
    } else {
      process.stdout.write('No ratchet changes.\n');
    }
  });
  process.exit(0);
}

if (mode === 'reset-model') {
  if (!agentArg) { process.stderr.write('error: --reset-model requires an agent name\n'); process.exit(2); }
  const agent = agentArg.replace(/^@/, '');
  await withRosterLock(ROSTER, async () => {
    const roster = readRoster();
    if (!roster.agents || !roster.agents[agent]) {
      process.stderr.write(`error: agent ${agent} not in roster\n`);
      process.exit(5);
    }
    roster.agents[agent].default_model = null;
    roster.agents[agent].corrections_since_last_upgrade = 0;
    roster.agents[agent].consecutive_successful_sonnet_tasks = 0;
    writeRoster(roster);
    logToImprovements(agent, `Manual model reset via prism-roster --reset-model.`);
    process.stdout.write(`Reset @${agent}: default_model=null, counters=0.\n`);
  });
  process.exit(0);
}

if (mode === 'tag-1-5' || mode === 'untag-1-5') {
  if (!agentArg) { process.stderr.write(`error: ${mode} requires an agent name\n`); process.exit(2); }
  const agent = agentArg.replace(/^@/, '');
  await withRosterLock(ROSTER, async () => {
    const roster = readRoster();
    if (!roster.agents || !roster.agents[agent]) {
      process.stderr.write(`error: agent ${agent} not in roster\n`);
      process.exit(5);
    }
    roster.agents[agent].requires_phase_1_5 = (mode === 'tag-1-5');
    writeRoster(roster);
    process.stdout.write(`@${agent}: requires_phase_1_5=${mode === 'tag-1-5'}\n`);
  });
  process.exit(0);
}

if (mode === 'skip-next-oob') {
  if (!agentArg || agentArg.startsWith('--')) {
    process.stderr.write('--skip-next-oob requires a spec name argument\n');
    process.exit(2);
  }
  const spec = agentArg.replace(/^@/, '');
  (async () => {
    await withRosterLock(ROSTER, async () => {
      const r = readRoster();
      if (!r.agents?.[spec]) {
        process.stderr.write(`[prism-roster] no agent '${spec}' in roster\n`);
        process.exit(1);
      }
      r.agents[spec].skip_next_oob = true;
      writeRoster(r);
      process.stdout.write(`[prism-roster] skip_next_oob set for '${spec}' (auto-cleared after one dispatch)\n`);
    });
    process.exit(0);
  })().catch(e => { process.stderr.write(`[prism-roster] --skip-next-oob failed: ${e.message}\n`); process.exit(1); });
}
