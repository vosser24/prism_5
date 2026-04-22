#!/usr/bin/env node
// ATLAS KB Auto-Sync (v2.1.28 Phase 3c)
//
// PostToolUse hook on Write / Edit / MultiEdit. When a tool write targets
// a KB-relevant path (~/.claude/{skills,agents,commands,rules}/** or plugin
// cache skills), append that path to the dirty flag file. The Stop hook
// drains the flag at session end and runs prism-kb-rebuild.mjs --sync
// --quiet in a detached background process.
//
// Zero per-turn latency (no inline rebuild) — just an append to a tiny
// text file.

import {readFileSync, appendFileSync, existsSync, mkdirSync} from 'fs';
import {join, dirname, resolve} from 'path';

const H = process.env.HOME || process.env.USERPROFILE;
const CLAUDE_DIR = join(H, '.claude');
const DIRTY_FLAG = join(CLAUDE_DIR, '.prism-kb-dirty');

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

function appendDirty(paths) {
  try {
    mkdirSync(dirname(DIRTY_FLAG), {recursive: true});
    const existing = new Set();
    if (existsSync(DIRTY_FLAG)) {
      for (const line of readFileSync(DIRTY_FLAG, 'utf-8').split('\n')) {
        if (line.trim()) existing.add(line.trim());
      }
    }
    const added = [];
    for (const p of paths) {
      const abs = resolve(p);
      if (!existing.has(abs)) {
        existing.add(abs);
        added.push(abs);
      }
    }
    if (added.length) {
      appendFileSync(DIRTY_FLAG, added.map(p => p + '\n').join(''));
    }
    return added;
  } catch {
    return [];
  }
}

function main() {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf-8')); }
  catch { process.exit(0); }

  if (!['Write', 'Edit', 'MultiEdit'].includes(input.tool_name)) process.exit(0);

  const paths = [...collectPaths(input.tool_input)].filter(isKbPath);
  if (!paths.length) process.exit(0);

  const added = appendDirty(paths);
  if (added.length) {
    process.stdout.write(`ATLAS KB: ${added.length} KB file(s) marked dirty. Cloud sync will fire at session end.`);
  }
  process.exit(0);
}

main();
