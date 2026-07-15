#!/usr/bin/env node
// Package A — remove harmful brevity signs. Asserts harmful phrases are GONE
// and files were not gutted. Dep-free. Exit non-zero on any failure.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Original byte lengths captured before the edits (wc -c).
const FILES = {
  phase1:   { path: 'skills/master-orchestrator/references/phase-1-execution.md', orig: 15657 },
  chat:     { path: 'skills/prism-chat/SKILL.md',                                  orig: 14397 },
  deepDive: { path: 'commands/prism-deep-dive.md',                                 orig: 13013 },
  master:   { path: 'agents/claude-master.md',                                     orig: 63573 },
};

const text = {};
const bytes = {};
for (const [k, v] of Object.entries(FILES)) {
  const buf = readFileSync(resolve(root, v.path));
  bytes[k] = buf.length;
  text[k] = buf.toString('utf8');
}

let failures = 0;
function assert(name, cond) {
  const tag = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`  [${tag}] ${name}`);
}

console.log('== Harmful phrase removal ==');
assert('phase-1-execution.md: no "≤5 lines"',            !text.phase1.includes('≤5 lines'));
assert('prism-chat SKILL.md: no "1-line why"',           !text.chat.includes('1-line why'));
assert('prism-chat SKILL.md: no "2–4 sentences" (en-dash)', !text.chat.includes('2–4 sentences'));
assert('prism-chat SKILL.md: no "2-4 sentences" (hyphen)',  !text.chat.includes('2-4 sentences'));
assert('prism-chat SKILL.md: no "one-sentence" cap',     !text.chat.includes('one-sentence'));
assert('prism-chat SKILL.md: no "one sentence of"',      !text.chat.includes('one sentence of'));
assert('prism-deep-dive.md: no "Terse (default)"',       !text.deepDive.includes('Terse (default)'));
assert('claude-master.md: no "Be terse, state actions"', !text.master.includes('Be terse, state actions'));

console.log('== Preserved-intent sanity ==');
assert('prism-chat SKILL.md: keeps "No preamble"',       text.chat.includes('no preamble') || text.chat.includes('No preamble'));
assert('prism-deep-dive.md: keeps "Match-the-user (default)"', text.deepDive.includes('Match-the-user (default)'));

console.log('== Not gutted (non-empty & > 90% of original bytes) ==');
for (const [k, v] of Object.entries(FILES)) {
  const ok = bytes[k] > 0 && bytes[k] > v.orig * 0.9;
  assert(`${v.path}: ${bytes[k]} bytes > 90% of ${v.orig}`, ok);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
