#!/usr/bin/env node
// hooks/prism-dispatch-cap.mjs
// v4.5 Layer 1 — log parallel-dispatch cap utilization
// Fires on PostToolUse matching the Agent tool. Reads stdin for the hook
// payload; opportunistically extracts dispatch-shape signals.

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ROUTING_LOG = join(homedir(), '.claude', '.prism-routing.jsonl');
const DEFAULT_CAP = 4; // v4.4 default; v4.6 may retune

async function readHookPayload() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw.trim()) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function main() {
  const payload = await readHookPayload();
  if (!payload || payload.tool_name !== 'Agent') process.exit(0);

  const entry = {
    ts: new Date().toISOString(),
    event: 'dispatch_cap',
    schema_version: 3,
    cap: DEFAULT_CAP,
    // Hook event doesn't expose siblings; that's OK — over many entries the
    // density gives the data v4.6 needs without per-event sibling counts.
    subagent_type: payload?.tool_input?.subagent_type ?? null,
    description: (payload?.tool_input?.description ?? '').slice(0, 80),
  };
  try { appendFileSync(ROUTING_LOG, JSON.stringify(entry) + '\n'); }
  catch (e) { process.stderr.write(`[dispatch-cap] log write failed: ${e.message}\n`); }
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`[dispatch-cap] uncaught: ${e.message}\n`);
  process.exit(0);
});
