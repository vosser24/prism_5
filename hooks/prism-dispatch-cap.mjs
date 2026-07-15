#!/usr/bin/env node
// hooks/prism-dispatch-cap.mjs
// v4.5 Layer 1 — log parallel-dispatch cap utilization
// Fires on PostToolUse matching the Agent tool. Reads stdin for the hook
// payload; opportunistically extracts dispatch-shape signals.

import { appendFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { resolveParallelCap } from './lib/prism-cap.mjs';

const ROUTING_LOG = join(homedir(), '.claude', '.prism-routing.jsonl');

const TASK_DIR_FRESH_MS = 10 * 60 * 1000; // 10 min

function countInflightTasks() {
  const claudeDir = join(homedir(), '.claude');
  let freshTaskDirs = 0;
  try {
    const now = Date.now();
    for (const name of readdirSync(claudeDir)) {
      if (!name.startsWith('.prism-task-')) continue;
      try {
        const st = statSync(join(claudeDir, name));
        if (st.isDirectory() && (now - st.mtimeMs) <= TASK_DIR_FRESH_MS) freshTaskDirs++;
      } catch {}
    }
  } catch {}
  return { freshTaskDirs };
}

export async function run(payload) {
  // Cheap early-exit: only react to Agent tool dispatches.
  if (!payload || payload.tool_name !== 'Agent') {
    return {exit: 0, stdout: '', stderr: ''};
  }

  // v4.7 K1: resolved per-invocation so the logged cap matches the active env.
  const cap = resolveParallelCap();
  const { freshTaskDirs } = countInflightTasks();
  const entry = {
    ts: new Date().toISOString(),
    event: 'dispatch_cap',
    schema_version: 4,
    cap,
    // PROXY: Claude Code's PostToolUse[Agent] event doesn't expose true sibling
    // dispatches, so we count fresh on-disk .prism-task-* dirs as an estimate of
    // concurrent work. queue_depth = how far past the cap that proxy reaches.
    actual_parallel: freshTaskDirs,
    queue_depth: Math.max(0, freshTaskDirs - cap),
    subagent_type: payload?.tool_input?.subagent_type ?? null,
    description: (payload?.tool_input?.description ?? '').slice(0, 80),
  };
  try { appendFileSync(ROUTING_LOG, JSON.stringify(entry) + '\n'); }
  catch (e) { process.stderr.write(`[dispatch-cap] log write failed: ${e.message}\n`); }
  return {exit: 0, stdout: '', stderr: ''};
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf-8');
  let payload = null;
  if (raw.trim()) {
    try { payload = JSON.parse(raw); } catch { /* ignore */ }
  }
  await run(payload);
  process.exit(0);
}

// Guard: only run main() when invoked as a hook, NOT when imported by tests.
const invokedDirectly = process.argv[1] && basename(process.argv[1]) === 'prism-dispatch-cap.mjs';
if (invokedDirectly) {
  main().catch((e) => {
    process.stderr.write(`[dispatch-cap] uncaught: ${e.message}\n`);
    process.exit(0);
  });
}
