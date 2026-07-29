#!/usr/bin/env node
// PRISM DB migrate (Phase 4)
//
// One-shot backfill:
//   - .prism-spend.jsonl          -> spend table
//   - .prism-routing.jsonl  -> model_routing table
//   - .prism-sessions/*.md        -> sessions table (parsed from the markdown digest)
//
// Idempotent: re-run inserts 0 new rows when sources are unchanged
// (UNIQUE constraints on spend + routing; PRIMARY KEY on sessions).
//
// Usage: node ~/.claude/tools/prism-db-migrate.mjs [--quiet]

import {readFileSync, existsSync, readdirSync, statSync} from 'fs';
import {join} from 'path';
import {openDb, close, appendSpend, appendRouting, upsertSession} from './prism-db.mjs';
import {prismHome} from '../hooks/lib/prism-home.mjs';

const H = prismHome();
const SPEND_LOG = join(H, '.claude', '.prism-spend.jsonl');
const ROUTING_LOG = join(H, '.claude', '.prism-routing.jsonl');
const SESSIONS_DIR = join(H, '.claude', '.prism-sessions');

const quiet = process.argv.includes('--quiet');
const log = (...a) => { if (!quiet) console.log(...a); };

function readJsonl(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function parseSessionMd(path) {
  const md = readFileSync(path, 'utf-8');
  const m = {
    session_id: null, start_ts: null, end_ts: null,
    projects: null, models: null,
    total_tokens: 0, total_cost_usd: 0,
    last_user_prompt: null,
  };
  const idMatch = md.match(/^# Session (\S+)/m);
  if (idMatch) m.session_id = idMatch[1];
  const pick = (re) => { const x = md.match(re); return x ? x[1].trim() : null; };
  m.start_ts = pick(/\*\*Start:\*\*\s*(.+)$/m);
  m.end_ts   = pick(/\*\*End:\*\*\s*(.+)$/m);
  m.projects = pick(/\*\*Projects:\*\*\s*(.+)$/m);
  m.models   = pick(/\*\*Models used:\*\*\s*(.+)$/m);
  const tokStr = pick(/\*\*Total tokens:\*\*\s*([\d.,]+)/);
  if (tokStr) m.total_tokens = Number(tokStr.replace(/[.,]/g, '')) || 0;
  const costStr = pick(/\*\*Estimated cost:\*\*\s*\$?([\d.]+)/);
  if (costStr) m.total_cost_usd = Number(costStr) || 0;
  const prompt = md.match(/## Last user prompt\s*\n```\s*\n([\s\S]*?)\n```/);
  if (prompt) m.last_user_prompt = prompt[1].trim().slice(0, 4000);
  return m;
}

function migrateSpend(db) {
  const rows = readJsonl(SPEND_LOG);
  let inserted = 0;
  db.prepare('BEGIN').run();
  try {
    for (const r of rows) {
      const changes = appendSpend(db, r);
      if (changes) inserted++;
    }
    db.prepare('COMMIT').run();
  } catch (e) {
    db.prepare('ROLLBACK').run();
    throw e;
  }
  return {seen: rows.length, inserted};
}

function migrateRouting(db) {
  const rows = readJsonl(ROUTING_LOG);
  let inserted = 0;
  db.prepare('BEGIN').run();
  try {
    for (const r of rows) {
      const changes = appendRouting(db, r);
      if (changes) inserted++;
    }
    db.prepare('COMMIT').run();
  } catch (e) {
    db.prepare('ROLLBACK').run();
    throw e;
  }
  return {seen: rows.length, inserted};
}

function migrateSessions(db) {
  if (!existsSync(SESSIONS_DIR)) return {seen: 0, upserted: 0};
  const files = readdirSync(SESSIONS_DIR).filter(n => n.endsWith('.md'));
  let upserted = 0;
  db.prepare('BEGIN').run();
  try {
    for (const f of files) {
      const p = join(SESSIONS_DIR, f);
      const st = statSync(p);
      const m = parseSessionMd(p);
      if (!m.session_id) continue;
      m.md_path = p;
      m.mtime = Math.floor(st.mtimeMs);
      upsertSession(db, m);
      upserted++;
    }
    db.prepare('COMMIT').run();
  } catch (e) {
    db.prepare('ROLLBACK').run();
    throw e;
  }
  return {seen: files.length, upserted};
}

function main() {
  const t0 = Date.now();
  const db = openDb();
  const s = migrateSpend(db);
  const r = migrateRouting(db);
  const se = migrateSessions(db);
  close(db);
  const ms = Date.now() - t0;
  log(`spend:    seen=${s.seen} inserted=${s.inserted}`);
  log(`routing:  seen=${r.seen} inserted=${r.inserted}`);
  log(`sessions: seen=${se.seen} upserted=${se.upserted}`);
  log(`took=${ms}ms`);
}

const invokedDirectly = (process.argv[1] || '').endsWith('prism-db-migrate.mjs');
if (invokedDirectly) main();
