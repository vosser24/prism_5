#!/usr/bin/env node
// Doctor fix-recipe gate (PRISM v5.1.4 UAT-fix).
// Run: node tests/v3/state/test-prism-doctor-fix-recipes.mjs
// Exit: 0 = all pass; 1 = any failure.
//
// Why: live UAT of /prism-doctor (test_prism_5, 2026-06-03) showed Symptom-1
// ("prism.env missing") recommending `cd ~/PRISM && bash scripts/bootstrap-prism-env.sh`
// — a script that NEVER existed in git history and a stale `~/PRISM` path. No
// .mjs writes prism.env; it is an OPTIONAL node-resolution pin (step 2 of the
// prism-exec fallback chain). With `node` on PATH a missing prism.env is the
// NORMAL healthy state, so flagging it is a false positive AND its fix is broken.
//
// This gate is a STATIC assertion over the command file:
//   1. no reference to the phantom `bootstrap-prism-env.sh`
//   2. no reference to the stale `~/PRISM` clone path
//   3. every `scripts/<name>.{sh,ps1}` referenced in ANY command file exists
//      on disk (general dangling-retired-script guard)
//   4. Symptom-1 detection is GUARDED on node being unresolvable (so a healthy
//      install with node-on-PATH is no longer flagged)

import { readFileSync, readdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');

let pass = 0; let total = 0;
function check(label, cond) {
  total++;
  if (cond) pass++;
  else console.log(`FAIL: ${label}`);
}

const doctorPath = join(REPO, 'commands', 'prism-doctor.md');
const doctor = readFileSync(doctorPath, 'utf-8');

// 1 + 2: regression guards for the exact phantom references this bug introduced.
check('prism-doctor.md does not reference phantom bootstrap-prism-env.sh',
  !/bootstrap-prism-env\.sh/.test(doctor));
check('prism-doctor.md does not reference stale ~/PRISM clone path',
  !/~\/PRISM\b/.test(doctor));

// 3: general dangling-script guard across ALL command files. A retired script
// (this session deleted scripts/install.{sh,ps1} etc.) must not survive as a
// copy-pasteable fix recipe. Match repo-relative scripts/<name>.{sh,ps1}.
const cmdDir = join(REPO, 'commands');
const cmdFiles = readdirSync(cmdDir).filter(n => n.endsWith('.md'));
const scriptRefRe = /\bscripts\/[\w.-]+\.(?:sh|ps1)\b/g;
const dangling = [];
for (const f of cmdFiles) {
  const body = readFileSync(join(cmdDir, f), 'utf-8');
  for (const m of body.matchAll(scriptRefRe)) {
    const rel = m[0];
    if (!existsSync(join(REPO, rel))) dangling.push(`${f} -> ${rel}`);
  }
}
if (dangling.length) console.log('  dangling script refs: ' + dangling.join(', '));
check('no command file references a non-existent scripts/*.{sh,ps1}', dangling.length === 0);

// 4: Symptom-1 detection must be guarded on node being unresolvable, not bare
// "prism.env does not exist". Extract the "#### 1." block (up to next "####").
const m = doctor.match(/####\s*1\.[^\n]*\n([\s\S]*?)(?=\n####\s*\d)/);
const sym1 = m ? m[1] : '';
check('Symptom-1 block found', sym1.length > 0);
check('Symptom-1 detection is guarded on node being unresolvable (not bare prism.env-absence)',
  /node/.test(sym1) && /(unresolvable|not\b[^.]*\bPATH|--version\b[^.]*fail|fails)/i.test(sym1));
check('Symptom-1 still references prism.env (the pin it is about)',
  /prism\.env/.test(sym1));

// ── Final ───────────────────────────────────────────────────────────────────
console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
