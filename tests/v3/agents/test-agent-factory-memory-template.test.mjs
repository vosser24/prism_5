#!/usr/bin/env node
// Task #39 / F27 — the agent-factory template must not tell newly-generated
// agents to emit the legacy `memory: true` value.
//
// Context: agents/agent-factory.md line ~396 (prose under "Agent.md must
// include:") instructed every agent the factory generates to set
// `memory: true` in its YAML frontmatter. `true` is not a native Claude
// Code enum value for the `memory` field — the accepted values are
// `user | project | local` (see agents/claude-master.md:419-421 and the
// live docs it cites). This is distinct from the file's OWN frontmatter
// (line 10), which was already corrected to `memory: project` by commit
// ac00421e8 (2026-07-15) — that commit fixed the template's self-declared
// value but missed the prose instruction telling the factory what value to
// WRITE into agents it generates, so the defect kept reproducing: three
// agents generated/updated after that commit (concurrency-durability-expert
// 2026-07-24, html-email-esp-engineer 2026-07-20, marketing-production-ops-
// specialist 2026-07-21 — 5 files counting flat+nested copies per D074)
// still carry literal `memory: true` under ~/.claude/agents/.
//
// The prior coverage for this class of bug (tests/v3/memory-field-normalize
// .test.mjs) only audits already-installed agent files on one hardcoded
// machine path set, is gitignored (.gitignore:56), and is NOT discovered by
// tests/v3/run-all.sh (git ls-files structurally excludes gitignored paths)
// — so it never caught this. This test instead asserts against the SHIPPED
// TEMPLATE SOURCE (agents/agent-factory.md) that lives in the repo and IS
// discovered by run-all.sh, so a future regression of this exact line fails
// CI instead of sitting invisible again.
//
// Run: node tests/v3/agents/test-agent-factory-memory-template.test.mjs

import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(__dirname, '..', '..', '..', 'agents', 'agent-factory.md');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { fail++; process.stdout.write(`  FAIL ${name}\n        ${e.stack || e.message}\n`); }
}
function assert(c, m) { if (!c) throw new Error('assert: ' + (m || '')); }

const content = readFileSync(TEMPLATE, 'utf8');

test('template file exists and is non-empty', () => {
  assert(content.length > 0, `expected content at ${TEMPLATE}`);
});

test('template does not contain the literal legacy value `memory: true` anywhere', () => {
  const hits = content
    .split('\n')
    .map((line, i) => ({line, n: i + 1}))
    .filter(({line}) => /memory:\s*true\b/.test(line));
  assert(
    hits.length === 0,
    `found legacy \`memory: true\` at line(s) ${hits.map(h => h.n).join(', ')}: ` +
      hits.map(h => JSON.stringify(h.line)).join(' | ')
  );
});

test('the "Agent.md must include" instruction line references a native memory enum value', () => {
  const m = content.match(/^- YAML:.*maxTurns,\s*memory:\s*(\S+)/m);
  assert(m, 'could not locate the "YAML: ... maxTurns, memory: <value>" instruction line');
  const value = m[1].replace(/[.,;]+$/, '');
  assert(
    ['project', 'user', 'local'].includes(value),
    `expected instruction to specify a native enum value (user|project|local), got '${value}'`
  );
});

test("the template's own frontmatter memory field is a native value (not legacy `true`)", () => {
  const end = content.indexOf('\n---', 3);
  assert(content.startsWith('---') && end !== -1, 'template has no YAML frontmatter block');
  const frontmatter = content.slice(0, end);
  const m = frontmatter.match(/^memory:\s*(\S+)\s*$/m);
  assert(m, 'template frontmatter has no memory: field');
  assert(
    ['project', 'user', 'local'].includes(m[1]),
    `expected template frontmatter memory field to be user|project|local, got '${m[1]}'`
  );
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
