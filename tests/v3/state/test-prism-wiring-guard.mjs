#!/usr/bin/env node
// WS-3 (v5.10.0) — "Deployed ≠ wired ≠ works" regression guard.
//
// Lesson class (v5.9.4): every ACL component passed unit/E2E, yet the loop was
// dead — leaf hooks shipped but UNWIRED (prism-acl-sessionend, prism-acl-notify),
// and the headless factory invocation authenticated-then-failed on `--bare` (F.7).
// Unit-green ≠ integrated. Two static guards lock the integration contract:
//
//   PART 1 — WIRING: each prism-*-dispatcher must reference (fan out to) the
//            leaf hooks shipped for its event. Locks the 0.4 regression
//            (sessionend→acl-sessionend, session-start→acl-notify) and fails if a
//            wired leaf hook is dropped or points at a non-existent file.
//
//   PART 2 — HEADLESS ARGS: the headless `claude` spawn (prism-acl-worker) must
//            pass `--settings {"disableAllHooks":true}` and must NOT pass `--bare`
//            (F.7: --bare strips OAuth → "Not logged in"). Comments that DISCUSS
//            --bare are stripped before the assertion so the doc survives.
//
// Run: node tests/v3/state/test-prism-wiring-guard.mjs

import {readFileSync, existsSync, readdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
const HOOKS = join(ROOT, 'hooks');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; process.stdout.write(`  ok  ${name}\n`); } else { fail++; process.stdout.write(`  FAIL ${name}\n`); } }

// Strip /* */ blocks and // line comments so assertions see CODE, not the prose
// that explains why a removed flag was removed.
//
// Single-pass state machine (not two chained regexes): a naive
// `/\/\*[\s\S]*?\*\//` block-comment strip run BEFORE line-comment stripping
// is fooled when a `//` comment's PROSE happens to contain a `/*`-lookalike
// substring (e.g. a glob path "references/*." or "Task*/TodoWrite") — it
// pairs that fake opener with the next `*/`-lookalike anywhere later in the
// file, silently swallowing genuine code in between (found live: it ate the
// prism-acl-notify.mjs wiring call in prism-session-start.mjs, ~480 lines
// away from the fake opener). Tracking string-literal state also keeps `/*`
// or `//` inside a quoted string from being misread as a comment start.
function stripComments(src) {
  const s = String(src);
  let out = '';
  let mode = 'code'; // 'code' | 'line' | 'block' | 'str'
  let strChar = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i], c2 = s[i + 1];
    if (mode === 'code') {
      if (c === '/' && c2 === '/') { mode = 'line'; i++; continue; }
      if (c === '/' && c2 === '*') { mode = 'block'; i++; continue; }
      if (c === '"' || c === "'" || c === '`') { mode = 'str'; strChar = c; out += c; continue; }
      out += c;
    } else if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += c; }
    } else if (mode === 'block') {
      if (c === '*' && c2 === '/') { mode = 'code'; i++; }
      else if (c === '\n') out += c;
    } else if (mode === 'str') {
      out += c;
      if (c === '\\') { out += c2 ?? ''; i++; continue; }
      if (c === strChar) mode = 'code';
    }
  }
  return out;
}
const readCode = (p) => stripComments(readFileSync(p, 'utf-8'));
const refsLeaf = (code, leaf) => new RegExp(`\\b${leaf.replace(/[.]/g, '\\.')}`).test(code);

// --- PART 1: WIRING SNAPSHOT ------------------------------------------------
// Required leaf hooks per dispatcher/event. Adding a NEW leaf hook for an event
// means wiring it here AND in the dispatcher — that is the point of the guard.
const WIRING = {
  'prism-userpromptsubmit-dispatcher.mjs': [
    'prism-hook.mjs', 'prism-prompt-tier-router.mjs', 'prism-memory-save-nudge.mjs', 'prism-skill-trigger-guard.mjs',
    'prism-live-agents-summary.mjs',
  ],
  'prism-pretooluse-dispatcher.mjs': [
    'prism-safety.mjs', 'prism-bash-hang-guard.mjs', 'prism-prepush-review.mjs', 'prism-mutation-guard.mjs', 'prism-parent-dispatch-guard.mjs',
    'prism-agent-model-guard.mjs', 'prism-parallel-guard.mjs', 'prism-skill-equip-nudge.mjs', 'prism-dispatch-dedup-guard.mjs', 'prism-task-tier-advisor.mjs',
  ],
  'prism-posttooluse-dispatcher.mjs': [
    'prism-kb-autosync.mjs', 'prism-agent-write-register.mjs', 'prism-skill-write-register.mjs',
    'prism-phase-0d-challenges.mjs', 'prism-phase-0d-oob.mjs', 'prism-panel-guard.mjs', 'prism-dispatch-cap.mjs',
  ],
  'prism-sessionend-dispatcher.mjs': [
    'prism-clean-nudge-flag.mjs', 'prism-git-clean-nudge.mjs', 'prism-acl-sessionend.mjs',
  ],
  'prism-subagentstop-dispatcher.mjs': [
    'prism-subagent-stop.mjs', 'prism-panel-guard.mjs', 'prism-phase-1-5-oob.mjs', 'prism-dispatch-dedup-guard.mjs',
  ],
  // session-start is not a fan-out dispatcher but it wires a leaf hook directly.
  'prism-session-start.mjs': ['prism-acl-notify.mjs'],
};

for (const [dispatcher, leaves] of Object.entries(WIRING)) {
  const p = join(HOOKS, dispatcher);
  if (!existsSync(p)) { check(`${dispatcher} exists`, false); continue; }
  const code = readCode(p);
  for (const leaf of leaves) {
    check(`${dispatcher} wires ${leaf}`, refsLeaf(code, leaf));
    check(`${leaf} (wired by ${dispatcher}) exists on disk`, existsSync(join(HOOKS, leaf)));
  }
}

// --- PART 2: HEADLESS ARG GUARD (F.7 lock) ----------------------------------
const WORKER = join(HOOKS, 'prism-acl-worker.mjs');
const workerCode = readCode(WORKER);
check('acl-worker passes --settings', /--settings/.test(workerCode));
check('acl-worker passes disableAllHooks', /disableAllHooks/.test(workerCode));
check('acl-worker does NOT pass --bare (F.7)', !/--bare/.test(workerCode));

// Repo-wide belt: no headless spawn anywhere in hooks/ or tools/ may pass --bare
// (in CODE — comments discussing it are stripped).
function scanDirForBare(dir) {
  const offenders = [];
  if (!existsSync(dir)) return offenders;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.mjs')) continue;
    const code = readCode(join(dir, f));
    if (/(?:^|\s|['"`])--bare\b/.test(code)) offenders.push(f);
  }
  return offenders;
}
const bareOffenders = [...scanDirForBare(HOOKS), ...scanDirForBare(join(ROOT, 'tools'))];
check(`no --bare in any hooks/tools spawn (found: ${bareOffenders.join(', ') || 'none'})`, bareOffenders.length === 0);

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
