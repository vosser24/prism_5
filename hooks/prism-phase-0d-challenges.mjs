#!/usr/bin/env node
// hooks/prism-phase-0d-challenges.mjs
// v4.5 Layer 1 — log Phase 0d challenge events
// Fires on PostToolUse matching Write to panel.json paths.
// Reads the Write tool's input (new panel.json content) and emits one JSONL
// event per challenge under each position.

import { appendFileSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const ROUTING_LOG = join(homedir(), '.claude', '.prism-routing.jsonl');

function panelPathFromToolInput(payload) {
  // PostToolUse for Write tool: tool_input.file_path is the destination.
  const fp = payload?.tool_input?.file_path;
  if (!fp) return null;
  if (!/\.prism-task-[^/\\]+[/\\]panel\.json$/.test(fp)) return null;
  return fp;
}

function extractTaskSha(panelPath) {
  const m = panelPath.match(/\.prism-task-([^/\\]+)/);
  return m ? m[1] : 'unknown';
}

export async function run(payload) {
  // Cheap early-exit: only proceed when payload points at a panel.json path.
  const panelPath = panelPathFromToolInput(payload);
  if (!panelPath) return {exit: 0, stdout: '', stderr: ''};

  let panel;
  try {
    panel = JSON.parse(readFileSync(panelPath, 'utf-8'));
  } catch (e) {
    process.stderr.write(`[phase-0d-challenges] cannot read ${panelPath}: ${e.message}\n`);
    return {exit: 0, stdout: '', stderr: ''};
  }

  const taskSha = extractTaskSha(panelPath);
  const ts = new Date().toISOString();
  for (const position of panel.positions ?? []) {
    const challenges = position.challenges ?? [];
    for (let i = 0; i < challenges.length; i++) {
      const c = challenges[i];
      const entry = {
        ts,
        event: 'phase_0d_challenge',
        schema_version: 4,
        task_sha: taskSha,
        position: position.title ?? position.name ?? '(unknown)',
        challenge_n: i + 1,
        evidence_class: c.evidence_class ?? 'UNCLASSIFIED',
        challenge_substance: c.substance_score ?? null,
      };
      try { appendFileSync(ROUTING_LOG, JSON.stringify(entry) + '\n'); }
      catch (e) { process.stderr.write(`[phase-0d-challenges] log write failed: ${e.message}\n`); }
    }
  }
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
  if (!payload) { process.exit(0); }
  await run(payload);
  process.exit(0);
}

// Guard: only run main() when invoked as a hook, NOT when imported by tests.
const invokedDirectly = process.argv[1] && basename(process.argv[1]) === 'prism-phase-0d-challenges.mjs';
if (invokedDirectly) {
  main().catch((e) => {
    process.stderr.write(`[phase-0d-challenges] uncaught: ${e.message}\n`);
    process.exit(0); // non-blocking; telemetry must never fail loud
  });
}
