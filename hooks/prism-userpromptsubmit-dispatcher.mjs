#!/usr/bin/env node
// PRISM UserPromptSubmit dispatcher — collapses 5 advisory hooks into ONE node
// process (one Windows console flash instead of five). Reads stdin ONCE (R5),
// parses ONCE, runs the five advisory run()s CONCURRENTLY (R3 — all are exit-0
// non-blocking), concatenates their stdout, exits 0.
import {readFileSync} from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dirname, join} from 'node:path';

const HOOKS = dirname(fileURLToPath(import.meta.url));

async function main() {
  let payload = {};
  try { payload = JSON.parse(readFileSync(0, 'utf-8') || '{}'); } catch { process.exit(0); }

  // Import each sub-hook's run() (side-effect-free thanks to invokedDirectly guards).
  // pathToFileURL is required on Windows: dynamic import() rejects bare Win32 paths
  // (e.g. "Y:\...") with ERR_UNSUPPORTED_ESM_URL_SCHEME — file:// URLs work on all
  // platforms.
  const hookPaths = [
    join(HOOKS, 'prism-hook.mjs'),
    join(HOOKS, 'prism-prompt-tier-router.mjs'),
    join(HOOKS, 'prism-memory-save-nudge.mjs'),
    join(HOOKS, 'prism-skill-trigger-guard.mjs'),
    join(HOOKS, 'prism-lesson-match.mjs'),
    join(HOOKS, 'prism-live-agents-summary.mjs'),
  ];

  const [hookMod, tierMod, memMod, skillMod, lessonMod, liveMod] = await Promise.all(
    hookPaths.map(p => import(pathToFileURL(p).href).catch(() => null))
  );

  // R5: SAME parsed payload to every run().
  const safeRun = async (m) => {
    if (!m || typeof m.run !== 'function') return { exit: 0, stdout: '', stderr: '' };
    try { return await m.run(payload); } catch { return { exit: 0, stdout: '', stderr: '' }; }
  };

  // Ordering dependency (preserves the old serial behavior): tier-router writes the
  // per-turn tier sentinel that skill-trigger-guard reads (force_opus). Start hook,
  // tier-router, and memory-nudge concurrently; run skill-trigger-guard AFTER
  // tier-router resolves so the sentinel is present. lesson-match has no ordering dep
  // (it doesn't read the tier sentinel) — runs concurrently with the others.
  const tierP   = safeRun(tierMod);
  const hookP   = safeRun(hookMod);
  const memP    = safeRun(memMod);
  const lessonP = safeRun(lessonMod);
  const liveP   = safeRun(liveMod);  // live-agents ledger summary (no ordering dep)
  const skillP  = tierP.then(() => safeRun(skillMod));
  const [hookRes, tierRes, memRes, skillRes, lessonRes, liveRes] = await Promise.all([hookP, tierP, memP, skillP, lessonP, liveP]);

  // Preserve original registration ORDER in concatenated output.
  const out = [hookRes, tierRes, memRes, skillRes, lessonRes, liveRes].map(r => r && r.stdout).filter(Boolean).join('\n');
  if (out) process.stdout.write(out);
  process.exit(0);
}
main().catch(e => { try { process.stderr.write('prism-ups-dispatcher: ' + (e && e.stack || e) + '\n'); } catch {} process.exit(0); });
