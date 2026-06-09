#!/usr/bin/env node
// R7 benchmark gate: assert the dispatcher wall-clock <= the sum of the N
// individual hook invocations it replaces, over the same payload. Median of
// REPS runs to damp Windows scheduler noise. Run: node tests/v3/bench/bench-hook-consolidation.mjs
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(__dirname, '..', '..', '..', 'hooks');
const EXEC = join(HOOKS, 'lib', 'prism-exec.sh');
const REPS = 7;
let pass = 0, fail = 0;

function median(xs) { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
function timeRun(args, input, env) {
  const t0 = process.hrtime.bigint();
  spawnSync('bash', args, {input, encoding: 'utf8', env});
  return Number(process.hrtime.bigint() - t0) / 1e6; // ms
}

function bench(label, individualHooks, dispatcher, payload) {
  const safeLabel = label.replace(/[/\\:*?"<>|]/g, '-');
  const home = mkdtempSync(join(tmpdir(), `prism-bench-${safeLabel}-`));
  const env = {...process.env, HOME: home, USERPROFILE: home, PRISM_DISABLE_OOB_REVIEW: '1'};
  try {
    const oldT = [], newT = [];
    for (let i = 0; i < REPS; i++) {
      let sum = 0;
      for (const h of individualHooks) sum += timeRun([EXEC, join(HOOKS, h)], payload, env);
      oldT.push(sum);
      newT.push(timeRun([EXEC, join(HOOKS, dispatcher)], payload, env));
    }
    const oldMed = median(oldT), newMed = median(newT);
    const ok = newMed <= oldMed;
    (ok ? pass++ : fail++);
    console.log(`  ${ok ? 'ok ' : 'FAIL'} ${label}: OLD ${oldMed.toFixed(0)}ms (${individualHooks.length} spawns) -> NEW ${newMed.toFixed(0)}ms (1 spawn)`);
  } finally { rmSync(home, {recursive: true, force: true}); }
}

bench('UserPromptSubmit',
  ['prism-hook.mjs', 'prism-prompt-tier-router.mjs', 'prism-memory-save-nudge.mjs', 'prism-skill-trigger-guard.mjs'],
  'prism-userpromptsubmit-dispatcher.mjs',
  JSON.stringify({prompt: 'implement this feature with tests', session_id: 'bench-ups', cwd: process.cwd()}));

bench('PostToolUse/Write',
  ['prism-kb-autosync.mjs', 'prism-agent-write-register.mjs', 'prism-phase-0d-challenges.mjs', 'prism-phase-0d-oob.mjs', 'prism-panel-guard.mjs'],
  'prism-posttooluse-dispatcher.mjs',
  JSON.stringify({tool_name: 'Write', tool_input: {file_path: join(process.cwd(), 'README.md')}}));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
