#!/usr/bin/env node
// PRISM PostToolUse dispatcher — matcher "Write|Edit|MultiEdit|Agent". One node
// process replaces up to 5 (Write). Routes by tool_name, runs the set CONCURRENTLY
// (R3 — PostToolUse cannot block). phase-0d-oob is fire-and-forget in its own run()
// (R4). Reads stdin ONCE (R5). Always exits 0 (PostToolUse cannot block).
import {readFileSync} from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dirname, join} from 'node:path';

const HOOKS = dirname(fileURLToPath(import.meta.url));
const imp = (f) => import(pathToFileURL(join(HOOKS, f)).href).catch(() => null);

const ROUTES = {
  Write:     [['prism-kb-autosync.mjs','run'],['prism-agent-write-register.mjs','run'],['prism-agent-quality-gate.mjs','run'],['prism-skill-write-register.mjs','run'],['prism-phase-0d-challenges.mjs','run'],['prism-phase-0d-oob.mjs','run'],['prism-panel-guard.mjs','runPostToolUse']],
  Edit:      [['prism-kb-autosync.mjs','run'],['prism-agent-write-register.mjs','run'],['prism-agent-quality-gate.mjs','run'],['prism-skill-write-register.mjs','run']],
  MultiEdit: [['prism-kb-autosync.mjs','run'],['prism-agent-write-register.mjs','run'],['prism-agent-quality-gate.mjs','run'],['prism-skill-write-register.mjs','run']],
  Agent:     [['prism-dispatch-cap.mjs','run']],
};

async function main() {
  let payload = {};
  try { payload = JSON.parse(readFileSync(0, 'utf-8') || '{}'); } catch { process.exit(0); }
  const route = ROUTES[payload.tool_name];
  if (!route) process.exit(0);
  const results = await Promise.all(route.map(async ([file, fn]) => {
    const m = await imp(file);
    if (!m || typeof m[fn] !== 'function') return { exit: 0, stdout: '', stderr: '' };
    try { return await m[fn](payload); } catch { return { exit: 0, stdout: '', stderr: '' }; }
  }));
  const out = results.map(r => r && r.stdout).filter(Boolean).join('\n');
  if (out) process.stdout.write(out);
  process.exit(0);
}
main().catch(() => process.exit(0));
