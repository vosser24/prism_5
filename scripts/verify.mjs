#!/usr/bin/env node
// PRISM install verification. Exits 0 on success, non-zero on failure.
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const H = homedir();
const CLAUDE = join(H, '.claude');

const required = [
  'hooks/prism-hook.mjs',
  'hooks/prism-session-start.mjs',
  'hooks/prism-safety.mjs',
  'tools/prism-kb-indexer.mjs',
  'tools/prism-kb-query.mjs',
  'tools/subagent-summary.py',
  'statusline-command.sh',
  'settings.json',
  'agents/master-orchestrator.md',
  'skills/prism-plan/SKILL.md',
];

let failed = 0;
for (const rel of required) {
  const p = join(CLAUDE, rel);
  if (existsSync(p)) console.log(`  OK  ${rel}`);
  else { console.log(`  MISSING  ${rel}`); failed++; }
}

try {
  const s = readFileSync(join(CLAUDE, 'settings.json'), 'utf-8');
  if (!s.includes('prism-hook.mjs')) { console.log('  MISSING  settings.json has no prism-hook entry'); failed++; }
  else console.log('  OK  settings.json wired');
  if (!s.includes('statusline-command.sh')) console.log('  WARN  settings.json missing statusLine entry (optional)');
} catch { console.log('  MISSING  settings.json unreadable'); failed++; }

if (failed) { console.error(`\nFAILED: ${failed} missing`); process.exit(1); }
console.log('\nPRISM install verified.');
