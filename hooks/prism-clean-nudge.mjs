#!/usr/bin/env node
// PRISM Clean Nudge (v4.0 Phase F) — SessionEnd[matcher=clear] + PreCompact
//
// Emits additionalContext reminding the user to run /prism-clean before
// durable session signals are lost on /clear or auto-compact. NEVER blocks
// (no exit 2, no stderr policy text). One file handles both events via a
// hook_event_name branch.
//
// Tunables (env vars):
//   PRISM_DISABLE_CLEAR_NUDGE=1      — suppress SessionEnd[clear] nudge
//   PRISM_DISABLE_PRECOMPACT_NUDGE=1 — suppress PreCompact nudge
//
// Failure-mode: ANY error path exits 0 with no stdout. Hooks must never
// degrade the user experience — a missing or malformed input must not
// prevent /clear or PreCompact from proceeding.

import {readFileSync, mkdirSync, appendFileSync} from 'node:fs';
import {join, dirname} from 'node:path';

const H = process.env.HOME || process.env.USERPROFILE || '';
const LOG = join(H, '.claude', '.prism-routing.jsonl');

function appendLog(obj) {
  try {
    mkdirSync(dirname(LOG), {recursive: true});
    appendFileSync(LOG, JSON.stringify(obj) + '\n');
  } catch { /* logging must never fail loudly */ }
}

const NUDGE_TEXT =
  'Session has accumulated panel decisions and deviations worth archiving. ' +
  'Run /prism-clean first so they get captured to docs/prism/ before /clear ' +
  '(or auto-compact) loses session context.';

try {
  const raw = readFileSync(0, 'utf-8');
  if (!raw.trim()) process.exit(0);

  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }
  if (!input || typeof input !== 'object') process.exit(0);

  const eventName = input.hook_event_name;
  const sessionId = input.session_id || 'anon';

  if (eventName === 'SessionEnd') {
    if (process.env.PRISM_DISABLE_CLEAR_NUDGE === '1') process.exit(0);
    if (input.reason !== 'clear') process.exit(0);
  } else if (eventName === 'PreCompact') {
    if (process.env.PRISM_DISABLE_PRECOMPACT_NUDGE === '1') process.exit(0);
  } else {
    process.exit(0);
  }

  appendLog({event: 'clean_nudge', hook_event: eventName, session_id: sessionId, ts: new Date().toISOString()});

  const out = {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: NUDGE_TEXT,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
} catch (e) {
  appendLog({event: 'clean_nudge', error: String(e), ts: new Date().toISOString()});
  process.exit(0);
}
