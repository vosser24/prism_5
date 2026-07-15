#!/usr/bin/env node
// WS-1 (v5.10.0) — Task API adoption guard.
//
// Tasks (TaskCreate/TaskUpdate/TaskList/TaskGet) are the default checklist
// surface since Claude Code v2.1.142, replacing TodoWrite. CLAUDE_CODE_ENABLE_TASKS=0
// is a backward-compat shim that turns Tasks OFF — PRISM must NEVER ship it.
//
// This guard locks two invariants:
//   1. No shipped settings fragment sets CLAUDE_CODE_ENABLE_TASKS (any value).
//      Leaving it unset = Tasks default = live checklist renders zero-config.
//   2. Every shipped agent that declares a RESTRICTED tools: allowlist includes
//      all four Task tools, so multi-step workers get the live checklist.
//      (Full-inherit agents — no tools: line, or `tools: *` / "All tools" — need
//      nothing; the four are inherited.)
//   3. The agent-factory template instructs new agents to include the four
//      Task tools by default.
//
// Run: node tests/v3/state/test-prism-task-api-adoption.mjs

import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; process.stdout.write(`  ok  ${name}\n`); } else { fail++; process.stdout.write(`  FAIL ${name}\n`); } }

const TASK_TOOLS = ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'];

// --- Invariant 1: no CLAUDE_CODE_ENABLE_TASKS in shipped settings ----------
for (const frag of ['settings.fragment.json', 'settings.json']) {
  const p = join(ROOT, frag);
  if (!existsSync(p)) continue;
  const raw = readFileSync(p, 'utf-8');
  check(`${frag} does not set CLAUDE_CODE_ENABLE_TASKS`, !/CLAUDE_CODE_ENABLE_TASKS/.test(raw));
}

// --- Helpers ---------------------------------------------------------------
function frontmatterToolsLine(mdPath) {
  const raw = readFileSync(mdPath, 'utf-8');
  // Only inspect the YAML frontmatter (between the first two --- fences).
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm = m ? m[1] : raw;
  const line = fm.split(/\r?\n/).find(l => /^tools:/.test(l));
  return line || null;
}

function isRestrictedAllowlist(toolsLine) {
  if (!toolsLine) return false; // no tools: line = full inherit
  const val = toolsLine.replace(/^tools:\s*/, '').trim();
  // `*` or "All tools" = full inherit, not restricted.
  if (val === '*' || /all tools/i.test(val)) return false;
  return true;
}

// --- Invariant 2: restricted-allowlist agents carry the four Task tools -----
const AGENTS_DIR = join(ROOT, 'agents');
const agentFiles = readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md'));
let restrictedSeen = 0;
for (const f of agentFiles) {
  const line = frontmatterToolsLine(join(AGENTS_DIR, f));
  if (!isRestrictedAllowlist(line)) continue;
  restrictedSeen++;
  for (const t of TASK_TOOLS) {
    check(`${f}: restricted allowlist includes ${t}`, new RegExp(`\\b${t}\\b`).test(line));
  }
}
check('at least one restricted-allowlist agent audited', restrictedSeen >= 1);

// --- Invariant 3: agent-factory template instructs the four Task tools ------
const factory = readFileSync(join(AGENTS_DIR, 'agent-factory.md'), 'utf-8');
for (const t of TASK_TOOLS) {
  check(`agent-factory template mentions ${t}`, new RegExp(`\\b${t}\\b`).test(factory));
}

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
