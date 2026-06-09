#!/usr/bin/env node
// PRISM SubagentStop dispatcher — collapses 3 hooks into ONE node process.
// Reads stdin ONCE (R5), runs the set CONCURRENTLY (R3). phase-1-5-oob is
// fire-and-forget inside its own run() (R4). panel-guard hard mode may exit 2,
// so the dispatcher returns the MAX exit code (R6) and the blocking sub-hook's stderr.
import {readFileSync} from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dirname, join} from 'node:path';

const HOOKS = dirname(fileURLToPath(import.meta.url));
const imp = (f) => import(pathToFileURL(join(HOOKS, f)).href).catch(() => null);

async function main() {
  let payload = {};
  try { payload = JSON.parse(readFileSync(0, 'utf-8') || '{}'); } catch { process.exit(0); }

  const [subStop, panel, oob] = await Promise.all([
    imp('prism-subagent-stop.mjs'), imp('prism-panel-guard.mjs'), imp('prism-phase-1-5-oob.mjs'),
  ]);

  const calls = [
    subStop && typeof subStop.run === 'function' ? subStop.run(payload) : null,
    panel && typeof panel.runSubagentStop === 'function' ? panel.runSubagentStop(payload) : null,
    oob && typeof oob.run === 'function' ? oob.run(payload) : null,
  ].map(p => p ? Promise.resolve(p).catch(() => ({ exit: 0, stdout: '', stderr: '' })) : Promise.resolve({ exit: 0, stdout: '', stderr: '' }));

  const results = await Promise.all(calls);
  const out = results.map(r => r && r.stdout).filter(Boolean).join('\n');
  const err = results.map(r => r && r.stderr).filter(Boolean).join('');
  const maxExit = results.reduce((mx, r) => Math.max(mx, (r && r.exit) || 0), 0); // R6
  if (out) process.stdout.write(out);
  if (err) process.stderr.write(err);
  process.exit(maxExit);
}
main().catch(() => process.exit(0));
