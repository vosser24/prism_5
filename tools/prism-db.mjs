#!/usr/bin/env node
// PRISM analytical DB (Phase 4)
//
// Central schema + connection helper backed by node:sqlite (experimental in
// Node >=22.5). Single file owns every table + FTS virtual table used by the
// recall tier-3, cost telemetry, and weekly rollups.
//
// Idempotent: calling openDb() repeatedly is cheap — schema creation uses
// IF NOT EXISTS.
//
// Public API:
//   openDb({readonly}?) -> DatabaseSync
//   appendSpend(db, row)
//   appendRouting(db, row)
//   upsertSession(db, row)
//   appendApiCall(db, row)
//   appendTaskTierAdvice(db, row)
//   close(db)

import {DatabaseSync} from 'node:sqlite';
import {existsSync, mkdirSync} from 'fs';
import {join, dirname} from 'path';
import {prismHome} from '../hooks/lib/prism-home.mjs';

const H = prismHome();
export const DB_PATH = join(H, '.claude', '.prism.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS spend (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  session_id TEXT,
  project TEXT,
  agent TEXT,
  model TEXT,
  tokens INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  UNIQUE(ts, session_id, agent, model)
);
CREATE INDEX IF NOT EXISTS idx_spend_ts ON spend(ts);
CREATE INDEX IF NOT EXISTS idx_spend_model ON spend(model);
CREATE INDEX IF NOT EXISTS idx_spend_session ON spend(session_id);
CREATE INDEX IF NOT EXISTS idx_spend_project ON spend(project);

CREATE TABLE IF NOT EXISTS model_routing (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  session_id TEXT,
  tool TEXT,
  subagent_type TEXT,
  tier_detected TEXT,
  compound_detected INTEGER DEFAULT 0,
  action TEXT,
  mode TEXT,
  explicit_model TEXT,
  prompt_hash TEXT,
  UNIQUE(ts, prompt_hash, action)
);
CREATE INDEX IF NOT EXISTS idx_routing_ts ON model_routing(ts);
CREATE INDEX IF NOT EXISTS idx_routing_tier ON model_routing(tier_detected);
CREATE INDEX IF NOT EXISTS idx_routing_action ON model_routing(action);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  start_ts TEXT,
  end_ts TEXT,
  projects TEXT,
  models TEXT,
  total_tokens INTEGER DEFAULT 0,
  total_cost_usd REAL DEFAULT 0,
  last_user_prompt TEXT,
  md_path TEXT,
  mtime INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_end ON sessions(end_ts);

CREATE VIRTUAL TABLE IF NOT EXISTS transcripts_fts USING fts5(
  session_id UNINDEXED,
  content
);

CREATE TABLE IF NOT EXISTS api_calls (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  notebook TEXT,
  source_id TEXT,
  tokens_est INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  status TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_ts ON api_calls(ts);
CREATE INDEX IF NOT EXISTS idx_api_kind ON api_calls(kind);

CREATE TABLE IF NOT EXISTS task_tier_advice (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  session_id TEXT,
  task_id TEXT,
  subject TEXT,
  tier TEXT,
  reason TEXT,
  compound INTEGER DEFAULT 0,
  h INTEGER DEFAULT 0,
  s INTEGER DEFAULT 0,
  o INTEGER DEFAULT 0,
  mode TEXT
);
CREATE INDEX IF NOT EXISTS idx_tta_ts ON task_tier_advice(ts);
CREATE INDEX IF NOT EXISTS idx_tta_tier ON task_tier_advice(tier);
CREATE INDEX IF NOT EXISTS idx_tta_session ON task_tier_advice(session_id);
`;

export function openDb({readonly = false} = {}) {
  if (!existsSync(dirname(DB_PATH))) mkdirSync(dirname(DB_PATH), {recursive: true});
  const db = new DatabaseSync(DB_PATH, {readOnly: readonly && existsSync(DB_PATH)});
  if (!readonly) {
    db.exec('PRAGMA journal_mode=WAL;');
    db.exec('PRAGMA busy_timeout=2000;');
    db.exec(SCHEMA);
  }
  return db;
}

export function close(db) {
  try { db.close(); } catch {}
}

export function appendSpend(db, row) {
  const stmt = db.prepare(`INSERT OR IGNORE INTO spend
    (ts, session_id, project, agent, model, tokens, cost_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const info = stmt.run(
    String(row.ts || new Date().toISOString()),
    row.session_id || null,
    row.project || null,
    row.agent || null,
    row.model || null,
    Number(row.tokens || 0),
    Number(row.cost_usd || row.cost || 0),
  );
  return info.changes;
}

export function appendRouting(db, row) {
  const stmt = db.prepare(`INSERT OR IGNORE INTO model_routing
    (ts, session_id, tool, subagent_type, tier_detected, compound_detected, action, mode, explicit_model, prompt_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const info = stmt.run(
    String(row.ts || new Date().toISOString()),
    row.session_id || null,
    row.tool || null,
    row.subagent_type || null,
    row.tier_detected || null,
    row.compound_detected ? 1 : 0,
    row.action || null,
    row.mode || null,
    row.explicit_model || null,
    row.prompt_hash || null,
  );
  return info.changes;
}

export function upsertSession(db, row) {
  const stmt = db.prepare(`INSERT INTO sessions
    (session_id, start_ts, end_ts, projects, models, total_tokens, total_cost_usd, last_user_prompt, md_path, mtime)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      end_ts=excluded.end_ts,
      projects=excluded.projects,
      models=excluded.models,
      total_tokens=excluded.total_tokens,
      total_cost_usd=excluded.total_cost_usd,
      last_user_prompt=excluded.last_user_prompt,
      md_path=excluded.md_path,
      mtime=excluded.mtime`);
  stmt.run(
    String(row.session_id),
    row.start_ts || null,
    row.end_ts || null,
    row.projects || null,
    row.models || null,
    Number(row.total_tokens || 0),
    Number(row.total_cost_usd || 0),
    row.last_user_prompt || null,
    row.md_path || null,
    Number(row.mtime || 0),
  );
}

export function appendApiCall(db, row) {
  const stmt = db.prepare(`INSERT INTO api_calls
    (ts, kind, notebook, source_id, tokens_est, duration_ms, status, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  stmt.run(
    String(row.ts || new Date().toISOString()),
    String(row.kind || 'unknown'),
    row.notebook || null,
    row.source_id || null,
    Number(row.tokens_est || 0),
    Number(row.duration_ms || 0),
    row.status || null,
    row.error || null,
  );
}

export function appendTaskTierAdvice(db, row) {
  const stmt = db.prepare(`INSERT INTO task_tier_advice
    (ts, session_id, task_id, subject, tier, reason, compound, h, s, o, mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  stmt.run(
    String(row.ts || new Date().toISOString()),
    row.session_id || null,
    row.task_id || null,
    row.subject || null,
    row.tier || null,
    row.reason || null,
    row.compound ? 1 : 0,
    Number(row.h || 0),
    Number(row.s || 0),
    Number(row.o || 0),
    row.mode || null,
  );
}

export function appendTranscriptChunk(db, sessionId, content) {
  if (!content || !sessionId) return;
  const stmt = db.prepare(`INSERT INTO transcripts_fts (session_id, content) VALUES (?, ?)`);
  stmt.run(String(sessionId), String(content));
}

// Convenience fire-and-forget: opens db, logs a row, closes. Swallows all errors.
export function safeLogApiCall(row) {
  try {
    const db = openDb();
    appendApiCall(db, row);
    close(db);
  } catch {}
}

const invokedDirectly = (process.argv[1] || '').endsWith('prism-db.mjs');
if (invokedDirectly) {
  const db = openDb();
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY type, name`).all();
  console.log(`DB: ${DB_PATH}`);
  console.log('Objects:');
  for (const r of tables) console.log('  ' + r.name);
  const counts = {
    spend: db.prepare('SELECT COUNT(*) AS n FROM spend').get().n,
    model_routing: db.prepare('SELECT COUNT(*) AS n FROM model_routing').get().n,
    sessions: db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,
    api_calls: db.prepare('SELECT COUNT(*) AS n FROM api_calls').get().n,
    task_tier_advice: db.prepare('SELECT COUNT(*) AS n FROM task_tier_advice').get().n,
  };
  console.log('Row counts:', counts);
  close(db);
}
