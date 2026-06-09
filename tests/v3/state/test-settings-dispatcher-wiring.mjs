#!/usr/bin/env node
import {readFileSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
let pass = 0, fail = 0;
function test(name, fn) { try { fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { fail++; console.log(`  FAIL ${name}\n        ${e.message}`); } }
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }
const s = JSON.parse(readFileSync(join(ROOT, 'settings.fragment.json'), 'utf-8'));
const cmds = (event) => (s.hooks[event] || []).flatMap(g => (g.hooks || []).map(h => h.command));
test('UserPromptSubmit has exactly ONE dispatcher entry (R1)', () => {
  const c = cmds('UserPromptSubmit');
  assert(c.length === 1, `expected 1, got ${c.length}`);
  assert(/prism-userpromptsubmit-dispatcher\.mjs/.test(c[0]), 'wires the dispatcher');
});
test('PostToolUse has ONE dispatcher entry matcher Write|Edit|MultiEdit|Agent', () => {
  const grp = s.hooks.PostToolUse;
  assert(grp.length === 1, `expected 1 group, got ${grp.length}`);
  assert(grp[0].matcher === 'Write|Edit|MultiEdit|Agent', 'matcher: ' + grp[0].matcher);
  assert(/prism-posttooluse-dispatcher\.mjs/.test(grp[0].hooks[0].command));
});
test('SubagentStop has ONE dispatcher entry', () => {
  const c = cmds('SubagentStop');
  assert(c.length === 1 && /prism-subagentstop-dispatcher\.mjs/.test(c[0]), 'cmds: ' + JSON.stringify(c));
});
test('SessionEnd has ONE dispatcher entry', () => {
  const c = cmds('SessionEnd');
  assert(c.length === 1 && /prism-sessionend-dispatcher\.mjs/.test(c[0]), 'cmds: ' + JSON.stringify(c));
});
test('PreToolUse UNCHANGED (Phase 5 deferred) — still has its enforcement entries', () => {
  const c = cmds('PreToolUse');
  assert(c.some(x => /prism-safety\.mjs/.test(x)), 'safety still wired individually');
  assert(c.some(x => /prism-parent-dispatch-guard\.mjs/.test(x)), 'dispatch-guard still wired');
});
test('all 4 dispatcher files exist on disk', () => {
  for (const f of ['prism-userpromptsubmit-dispatcher.mjs','prism-posttooluse-dispatcher.mjs','prism-subagentstop-dispatcher.mjs','prism-sessionend-dispatcher.mjs'])
    assert(existsSync(join(ROOT, 'hooks', f)), 'missing ' + f);
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
