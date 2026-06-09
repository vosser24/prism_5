#!/usr/bin/env node
// PRISM KB Auto-Sync (v2.1.28 Phase 3c; v5.0 F4 Phase E knowledge corpus)
//
// PostToolUse hook on Write / Edit / MultiEdit. Two independent dirty flags:
//   1. RESOURCE index (~/.claude/{skills,agents,commands,rules}/** or plugin
//      cache skills)  -> ~/.claude/.prism-kb-dirty   (drained -> prism-kb-rebuild.mjs)
//   2. KNOWLEDGE corpus (F4: docs/prism/{adjudications,lessons,plans}, panel.json,
//      home-global verdict logs) -> ~/.claude/.prism-kb-knowledge-dirty
//      (drained -> prism-kb-knowledge-rebuild.mjs). Project corpus is gated by the
//      project's .prism-kb-share.json (default-deny, per-corpus-type); verdict
//      paths are always marked dirty (always-on, exempt from the share marker).
// The two flags are SEPARATE so the two rebuilds never couple (design §5).
//
// Zero per-turn latency (no inline rebuild) — just an append to a tiny text file.

import {readFileSync, appendFileSync, existsSync, mkdirSync} from 'fs';
import {join, dirname, resolve, basename} from 'path';

const KB_PATH_PATTERNS = [
  /[/\\]\.claude[/\\]skills[/\\]/i,
  /[/\\]\.claude[/\\]agents[/\\]/i,
  /[/\\]\.claude[/\\]commands[/\\]/i,
  /[/\\]\.claude[/\\]rules[/\\]/i,
  /[/\\]\.claude[/\\]plugins[/\\]cache[/\\].+[/\\]skills[/\\]/i,
];

function isKbPath(p) {
  if (!p) return false;
  return KB_PATH_PATTERNS.some(rx => rx.test(String(p)));
}

// ── F4 knowledge-corpus classification ────────────────────────────────────────
// The four shareable corpus types (gated by .prism-kb-share.json) + always-on verdicts.
const KNOWLEDGE_SHAREABLE_TYPES = ['adjudication', 'lesson', 'plan', 'panel-rationale'];

// knowledgeCorpusType(absPath) -> corpus type or null, purely from the path shape.
export function knowledgeCorpusType(p) {
  if (!p) return null;
  const s = String(p).replace(/\\/g, '/');
  if (/\/docs\/prism\/adjudications\/[^/]+\.md$/i.test(s)) return 'adjudication';
  if (/\/docs\/prism\/lessons\/[^/]+\.md$/i.test(s)) return 'lesson';
  if (/\/docs\/prism\/plans\/[^/]+\.md$/i.test(s)) return 'plan';
  if (/\/tasks\/workspace\/.*\/panel\.json$/i.test(s)) return 'panel-rationale';
  // Home-global verdict logs (always-on, exempt from share marker).
  const base = basename(s);
  if (base === '.prism-phase-1-5-verdicts.jsonl') return 'verdict';
  if (/^\.prism-phase-.*-verdicts-.*\.json$/i.test(base)) return 'verdict';
  return null;
}

// Walk up from a path to the nearest ancestor carrying a .prism-kb-share.json marker.
function findShareRoot(absPath, existsFn) {
  let dir = dirname(String(absPath));
  let prev = null;
  while (dir && dir !== prev) {
    if (existsFn(join(dir, '.prism-kb-share.json'))) return dir;
    prev = dir;
    dir = dirname(dir);
  }
  return null;
}

// Read shared_types from a project's .prism-kb-share.json (or null).
function readShareTypesFromDisk(root) {
  try {
    const parsed = JSON.parse(readFileSync(join(root, '.prism-kb-share.json'), 'utf-8'));
    return Array.isArray(parsed && parsed.shared_types) ? parsed.shared_types : null;
  } catch { return null; }
}

// isKnowledgeDirtyPath(absPath, {existsFn, readShareTypes}) -> bool.
// Verdict paths always dirty. Project corpus dirty ONLY when the path's type is in
// the owning project's shared_types (default-deny when no marker / type withheld).
export function isKnowledgeDirtyPath(p, {existsFn = existsSync, readShareTypes = readShareTypesFromDisk} = {}) {
  const type = knowledgeCorpusType(p);
  if (!type) return false;
  if (type === 'verdict') return true;                 // always-on, exempt
  const root = findShareRoot(p, existsFn);
  if (!root) return false;                             // default-deny
  const shared = readShareTypes(root);
  return Array.isArray(shared) && shared.includes(type) && KNOWLEDGE_SHAREABLE_TYPES.includes(type);
}

function collectPaths(ti) {
  const out = new Set();
  if (!ti) return out;
  if (typeof ti.file_path === 'string') out.add(ti.file_path);
  if (Array.isArray(ti.edits)) {
    for (const e of ti.edits) {
      if (e && typeof e.file_path === 'string') out.add(e.file_path);
    }
  }
  return out;
}

function appendDirtyTo(flagPath, paths) {
  try {
    mkdirSync(dirname(flagPath), {recursive: true});
    // Append-only: dedup just within THIS call (cheap, in-memory). We intentionally
    // do NOT read+dedup against the existing flag file on every PostToolUse turn —
    // the drain (runKnowledgeRebuild) derives roots through a Set and rebuilds from
    // directories, so duplicate path-lines are harmless. Saves one readFileSync/turn
    // (matters on SMB-mounted trees). [v5.0 review P3]
    const seen = new Set();
    const added = [];
    for (const p of paths) {
      const abs = resolve(p);
      if (!seen.has(abs)) {
        seen.add(abs);
        added.push(abs);
      }
    }
    if (added.length) {
      appendFileSync(flagPath, added.map(p => p + '\n').join(''));
    }
    return added;
  } catch {
    return [];
  }
}

export async function run(payload) {
  // Recompute per-call so HOME-override in tests is honored.
  const H = process.env.HOME || process.env.USERPROFILE;
  const CLAUDE_DIR = join(H, '.claude');
  const DIRTY_FLAG = join(CLAUDE_DIR, '.prism-kb-dirty');
  const KNOWLEDGE_DIRTY_FLAG = join(CLAUDE_DIR, '.prism-kb-knowledge-dirty');

  // Cheap early-exit: only react to write-class tools.
  if (!['Write', 'Edit', 'MultiEdit'].includes(payload.tool_name)) {
    return {exit: 0, stdout: '', stderr: ''};
  }

  const allPaths = [...collectPaths(payload.tool_input)];

  const kbPaths = allPaths.filter(isKbPath);
  const knowledgePaths = allPaths.filter(p => isKnowledgeDirtyPath(p));

  const msgs = [];
  if (kbPaths.length) {
    const added = appendDirtyTo(DIRTY_FLAG, kbPaths);
    if (added.length) msgs.push(`PRISM KB: ${added.length} resource file(s) marked dirty. Cloud sync will fire at session end.`);
  }
  if (knowledgePaths.length) {
    const added = appendDirtyTo(KNOWLEDGE_DIRTY_FLAG, knowledgePaths);
    if (added.length) msgs.push(`PRISM KB: ${added.length} knowledge file(s) marked dirty. Cross-project index will refresh at session end.`);
  }
  const stdout = msgs.join('\n');
  return {exit: 0, stdout, stderr: ''};
}

async function main() {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf-8')); }
  catch { process.exit(0); }

  const {exit: code, stdout} = await run(input);
  if (stdout) process.stdout.write(stdout);
  process.exit(code);
}

// Guard: only run main() when invoked as a hook, NOT when imported by tests.
const invokedDirectly = process.argv[1] && basename(process.argv[1]) === 'prism-kb-autosync.mjs';
if (invokedDirectly) main();
