#!/usr/bin/env node
// /prism-audit OOB-reviewer frontmatter exemption (PRISM v5.1.7 UAT-fix).
// Run: node tests/v3/state/test-prism-audit-oob-exemption.mjs
// Exit: 0 = all pass; 1 = any failure.
//
// Live UAT (2026-06-03): /prism-audit flagged PRISM's own out-of-band reviewers
// (phase-0d-oob-reviewer, phase-1-5-oob-reviewer, -lite) for "missing model /
// maxTurns" frontmatter. False positive — these are NOT Agent-dispatched:
//   - hooks/prism-phase-0d-oob.mjs spawns `claude -p --model claude-sonnet-4-6`
//     (model HARDCODED in the hook; frontmatter model is ignored).
//   - hooks/prism-phase-1-5-oob.mjs reads model FROM frontmatter at invocation.
//   - both are one-shot `claude -p` calls, so `maxTurns` (an Agent-dispatch
//     turn-loop cap) is meaningless for them.
// So the audit's Agent-YAML check must EXEMPT *-oob-reviewer agents from the
// model/maxTurns requirement. This gate asserts the exemption is documented, and
// verifies the source facts it relies on (so the exemption stays honest).

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');

let pass = 0, total = 0;
function check(label, cond) { total++; if (cond) pass++; else console.log(`FAIL: ${label}`); }

const audit = readFileSync(join(REPO, 'commands', 'prism-audit.md'), 'utf-8');

// Locate the Agent-YAML frontmatter check block (Step 2 — PRISM surface integrity).
const m = audit.match(/Agent YAML:[\s\S]*?(?=\n(?:Roster integrity|Hook health|###))/);
const agentYaml = m ? m[0] : '';
check('Agent-YAML check block found', agentYaml.length > 0);

// The exemption must (a) name the oob-reviewer class and (b) cover model+maxTurns.
check('audit exempts *-oob-reviewer agents from the frontmatter check',
  /oob-?reviewer/i.test(agentYaml) && /exempt|optional|not\s+(?:required|flag)/i.test(agentYaml));
check('exemption mentions both model and maxTurns',
  /oob-?reviewer/i.test(agentYaml) && /model/i.test(agentYaml) && /maxturns/i.test(agentYaml));
check('exemption rationale references hook/SDK invocation (claude -p / not Agent-dispatched)',
  /claude\s*-p|hook|sdk|not\s+agent-?dispatch/i.test(agentYaml));

// Source-fact guards: keep the exemption honest by asserting the code it relies on.
const oob0d = readFileSync(join(REPO, 'hooks', 'prism-phase-0d-oob.mjs'), 'utf-8');
check('phase-0d hook still hardcodes --model (so frontmatter model is moot there)',
  /--model['"\s,]+claude-/.test(oob0d) || /'--model'\s*,\s*'claude-/.test(oob0d));

const oob15 = readFileSync(join(REPO, 'hooks', 'prism-phase-1-5-oob.mjs'), 'utf-8');
check('phase-1-5 hook still invokes via claude -p (one-shot, no turn loop)',
  /'-p'/.test(oob15) && /--model/.test(oob15));

console.log(`tests passed: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
