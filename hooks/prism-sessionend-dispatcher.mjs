#!/usr/bin/env node
// PRISM SessionEnd dispatcher — collapses the SessionEnd flag-writers + the ACL
// detection trigger into ONE node process.
//   • clean-nudge   — self-gates: fires only on reason 'clear'
//   • git-clean     — self-gates: skips reason 'clear'
//   • acl-sessionend— self-gates on ACL enabled + debounce; spawns the detached
//                     Autonomous Capability Loop worker (fire-and-forget).
// All run()s no-op when not their turn, so run them concurrently. exit 0 always.
// (v5.9.4: acl-sessionend added — it was deployed but previously UNWIRED, so the
//  ACL never auto-fired on session end.)
import {readFileSync} from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dirname, join} from 'node:path';
const HOOKS = dirname(fileURLToPath(import.meta.url));
const imp = (f) => import(pathToFileURL(join(HOOKS, f)).href).catch(() => null);
const call = (m) => (m && typeof m.run === 'function' ? Promise.resolve(m.run(payload)).catch(() => {}) : Promise.resolve());
let payload = {};
async function main() {
  try { payload = JSON.parse(readFileSync(0, 'utf-8') || '{}'); } catch { process.exit(0); }
  const [clean, git, acl] = await Promise.all([
    imp('prism-clean-nudge-flag.mjs'),
    imp('prism-git-clean-nudge.mjs'),
    imp('prism-acl-sessionend.mjs'),
  ]);
  await Promise.all([call(clean), call(git), call(acl)]);
  process.exit(0);
}
main().catch(() => process.exit(0));
