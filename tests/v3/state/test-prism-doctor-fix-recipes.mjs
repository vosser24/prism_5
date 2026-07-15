#!/usr/bin/env node
// Doctor command-correctness gate (PRISM v5.1.4 / v5.1.5 UAT-fixes).
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

// 5: bootstrap-state coverage (v5.1.5). The handoff advertises /prism-doctor as
// the guided alt for repairing a clobbered `.prism-state.json`, but pre-5.1.5 the
// doctor had NO signal for it (its 12 signals covered hooks/roster/settings/env,
// not the bootstrap state machine). Assert the command now validates that state
// and recommends the real repair (`prism-state.mjs adopt`), existence-guarded so
// it never false-flags a non-bootstrapped dir (e.g. the PRISM repo itself, where
// `prism-state.mjs validate` returns invalid_schema for a missing file).
check('doctor validates bootstrap state via prism-state.mjs validate',
  /prism-state\.mjs\s+validate/.test(doctor));
check('doctor recommends prism-state.mjs adopt as the repair',
  /prism-state\.mjs\s+adopt/.test(doctor));
const symBlocks = doctor.match(/####\s*\d+\.[^\n]*\n[\s\S]*?(?=\n####\s*\d|\n###\s)/g) || [];
const hasStateSymptom = symBlocks.some(b =>
  /\.prism-state\.json/.test(b) && /(corrupt|clobber|invalid)/i.test(b) && /adopt/.test(b));
check('doctor has a corrupt/clobbered bootstrap-state symptom with the adopt fix', hasStateSymptom);
check('bootstrap-state check is existence-guarded (no false-flag on non-projects)',
  /\.prism-state\.json[\s\S]{0,400}?\bexists?\b/i.test(doctor) ||
  /\bif\b[\s\S]{0,80}?\.prism-state\.json/i.test(doctor));
// 5b: the repair must sequence `reset` BEFORE `adopt` (v5.1.6). Symptom #11
// ALWAYS describes an existing corrupt file, and `prism-state.mjs adopt` refuses
// with "state already exists; use reset first" when the file is present. So a
// recipe of `adopt` alone is broken for the exact scenario it targets.
check('bootstrap-state repair sequences reset BEFORE adopt (adopt refuses on an existing corrupt file)',
  symBlocks.some(b => /\.prism-state\.json/.test(b) && /\breset\b[\s\S]*?\badopt\b/.test(b)));

// ── Final ───────────────────────────────────────────────────────────────────
console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
