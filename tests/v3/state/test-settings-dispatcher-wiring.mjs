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
test('PreToolUse has ONE dispatcher entry (Phase 5 consolidation, v5.7)', () => {
  const grp = s.hooks.PreToolUse;
  assert(grp.length === 1, `expected 1 group, got ${grp.length}`);
  const c = cmds('PreToolUse');
  assert(c.length === 1, `expected 1 command, got ${c.length}`);
  assert(/prism-pretooluse-dispatcher\.mjs/.test(c[0]), 'wires the PreToolUse dispatcher: ' + c[0]);
  // matcher must cover every tool the 7 folded guards routed on.
  for (const tool of ['Bash','PowerShell','Agent','TaskCreate','Edit','Write','MultiEdit','NotebookEdit','WebFetch','WebSearch'])
    assert(new RegExp(`(^|\\|)${tool}(\\||$)`).test(grp[0].matcher), `matcher missing ${tool}: ${grp[0].matcher}`);
  // the individual guards must NOT be wired individually anymore.
  assert(!c.some(x => /prism-safety\.mjs|prism-parent-dispatch-guard\.mjs/.test(x)), 'guards must not be wired individually post-consolidation');
});
test('all 5 dispatcher files exist on disk', () => {
  for (const f of ['prism-userpromptsubmit-dispatcher.mjs','prism-posttooluse-dispatcher.mjs','prism-pretooluse-dispatcher.mjs','prism-subagentstop-dispatcher.mjs','prism-sessionend-dispatcher.mjs'])
    assert(existsSync(join(ROOT, 'hooks', f)), 'missing ' + f);
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
