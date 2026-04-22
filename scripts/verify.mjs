#!/usr/bin/env node
// PRISM install verification. Exits 0 on success, non-zero on failure.
import { existsSync, readFileSync } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';

const H = homedir();
const CLAUDE = join(H, '.claude');
const IS_WIN = platform() === 'win32';

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
  IS_WIN ? 'hooks/lib/prism-exec.cmd' : 'hooks/lib/prism-exec.sh',
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

  const wrapperToken = IS_WIN ? 'prism-exec.cmd' : 'prism-exec.sh';
  if (!s.includes(wrapperToken)) {
    console.log(`  WARN  settings.json does not reference ${wrapperToken} — hooks may be calling node directly (pre-2.3 install)`);
  } else console.log(`  OK  settings.json uses ${wrapperToken}`);

  const staleRe = IS_WIN
    ? /"command"\s*:\s*"node\s+%USERPROFILE%\\\\?\.claude\\\\?hooks\\\\?prism-[^"]+\.mjs"/
    : /"command"\s*:\s*"node\s+~\/\.claude\/hooks\/prism-[^"]+\.mjs"/;
  if (staleRe.test(s)) {
    console.log('  WARN  settings.json has stale raw-node PRISM hook entries (pre-2.3). Re-run INSTALL.md §4 to prune.');
  }
} catch { console.log('  MISSING  settings.json unreadable'); failed++; }

const prismEnv = join(CLAUDE, 'prism.env');
if (existsSync(prismEnv)) console.log('  OK  prism.env present (hook fast path)');
else console.log('  HINT  prism.env absent — wrappers will auto-discover node each hook firing. Re-run INSTALL.md §2.5 to pin.');

if (failed) { console.error(`\nFAILED: ${failed} missing`); process.exit(1); }
console.log('\nPRISM install verified.');
