#!/usr/bin/env node
// PRISM SessionEnd dispatcher — collapses 2 flag-writers into ONE node process.
// Both run()s self-gate on `reason` (clean-nudge fires only on 'clear'; git-clean-nudge
// skips 'clear'), so run BOTH concurrently and let each no-op when not its turn. exit 0 always.
import {readFileSync} from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dirname, join} from 'node:path';
const HOOKS = dirname(fileURLToPath(import.meta.url));
const imp = (f) => import(pathToFileURL(join(HOOKS, f)).href).catch(() => null);
async function main() {
  let payload = {};
  try { payload = JSON.parse(readFileSync(0, 'utf-8') || '{}'); } catch { process.exit(0); }
  const [clean, git] = await Promise.all([imp('prism-clean-nudge-flag.mjs'), imp('prism-git-clean-nudge.mjs')]);
  await Promise.all([
    clean && typeof clean.run === 'function' ? Promise.resolve(clean.run(payload)).catch(() => {}) : Promise.resolve(),
    git && typeof git.run === 'function' ? Promise.resolve(git.run(payload)).catch(() => {}) : Promise.resolve(),
  ]);
  process.exit(0);
}
main().catch(() => process.exit(0));
