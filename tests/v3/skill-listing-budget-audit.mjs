#!/usr/bin/env node
// Package D-budget audit: measure skill-listing footprint (description + when_to_use)
// across all ACTIVE skills (user ~/.claude/skills + enabled plugin versions).
// Read-only. No edits. Prints a table + budget verdict.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const USER_SKILLS = join(HOME, '.claude', 'skills');

// Enabled plugin skill roots (from installed_plugins.json, enabled versions only)
const PLUGIN_ROOTS = [
  ['superpowers', join(HOME, '.claude/plugins/cache/claude-plugins-official/superpowers/6.1.1/skills')],
  ['chrome-devtools-mcp', join(HOME, '.claude/plugins/cache/claude-plugins-official/chrome-devtools-mcp/1.5.0/skills')],
  ['claude-md-management', join(HOME, '.claude/plugins/cache/claude-plugins-official/claude-md-management/1.0.0/skills')],
  ['claude-code-setup', join(HOME, '.claude/plugins/cache/claude-plugins-official/claude-code-setup/1.0.0/skills')],
  ['supabase', join(HOME, '.claude/plugins/cache/claude-plugins-official/supabase/0.1.11/skills')],
  ['firecrawl', join(HOME, '.claude/plugins/cache/claude-plugins-official/firecrawl/1.0.9/skills')],
  ['skill-creator', join(HOME, '.claude/plugins/cache/claude-plugins-official/skill-creator/317b8988055b/skills')],
  ['frontend-design', join(HOME, '.claude/plugins/cache/claude-plugins-official/frontend-design/317b8988055b/skills')],
  ['playground', join(HOME, '.claude/plugins/cache/claude-plugins-official/playground/317b8988055b/skills')],
  ['karpathy-skills', join(HOME, '.claude/plugins/cache/karpathy-skills/andrej-karpathy-skills/1.0.0/skills')],
  ['claude-mem', join(HOME, '.claude/plugins/cache/thedotmack/claude-mem/13.10.2/skills')],
];

const CAP = 1536; // skillListingMaxDescChars default (per-entry cap on description+when_to_use)

function parseFrontmatter(text) {
  // Strip BOM
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const body = m[1];
  const out = {};
  // handle simple key: value and folded (>/|) block scalars for description/when_to_use
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2];
    if (val === '>' || val === '|' || val === '>-' || val === '|-' || val === '') {
      // block scalar: gather subsequent more-indented lines
      const collected = [];
      let j = i + 1;
      const baseIndent = (lines[j] && lines[j].match(/^(\s*)/)[1].length) || 0;
      while (j < lines.length) {
        if (lines[j].trim() === '') { collected.push(''); j++; continue; }
        const ind = lines[j].match(/^(\s*)/)[1].length;
        if (ind < baseIndent || /^[A-Za-z0-9_-]+:\s/.test(lines[j])) break;
        collected.push(lines[j].slice(baseIndent));
        j++;
      }
      if (val === '' && collected.length === 0) {
        // plain empty value
        out[key] = '';
        continue;
      }
      if (collected.length) {
        // folded '>' joins with spaces; literal '|' keeps newlines. For char count either is close.
        const folded = (val.startsWith('>')) ? collected.join(' ').replace(/\s+/g, ' ').trim()
                                              : collected.join('\n').trim();
        out[key] = folded;
        i = j - 1;
        continue;
      }
    }
    // quoted or plain single line
    val = val.replace(/^["']|["']$/g, '');
    out[key] = val;
  }
  return out;
}

function collectSkills(root, source) {
  const rows = [];
  if (!existsSync(root)) return rows;
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    let st; try { st = statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const skillFile = join(dir, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    const text = readFileSync(skillFile, 'utf8');
    const fm = parseFrontmatter(text);
    if (!fm) continue;
    const name = fm.name || entry;
    const desc = fm.description || '';
    const wtu = fm['when_to_use'] || fm['when-to-use'] || '';
    const dmi = String(fm['disable-model-invocation'] || '').toLowerCase() === 'true';
    const footprint = desc.length + wtu.length;
    rows.push({ source, name, descLen: desc.length, wtuLen: wtu.length, footprint, dmi, path: skillFile });
  }
  return rows;
}

let all = [];
all.push(...collectSkills(USER_SKILLS, 'PRISM-user'));
for (const [name, root] of PLUGIN_ROOTS) all.push(...collectSkills(root, 'plugin:' + name));

// Exclude disable-model-invocation skills from the listing budget (they aren't model-listed the same way)
const listed = all.filter(r => !r.dmi);

all.sort((a, b) => b.footprint - a.footprint);

console.log('=== ALL ACTIVE SKILLS (sorted by footprint desc) ===');
console.log('footprint  desc  wtu  dmi  source            name');
for (const r of all) {
  console.log(
    String(r.footprint).padStart(9),
    String(r.descLen).padStart(5),
    String(r.wtuLen).padStart(4),
    (r.dmi ? 'YES' : ' - ').padStart(3),
    r.source.padEnd(20),
    r.name
  );
}

const total = all.reduce((s, r) => s + r.footprint, 0);
const totalListed = listed.reduce((s, r) => s + r.footprint, 0);
const overCap = all.filter(r => r.footprint > CAP);
const prismOverCap = overCap.filter(r => r.source === 'PRISM-user');

console.log('\n=== TOTALS ===');
console.log('Total SKILL.md (active):', all.length);
console.log('  PRISM-user skills:', all.filter(r => r.source === 'PRISM-user').length);
console.log('  plugin skills:', all.filter(r => r.source !== 'PRISM-user').length);
console.log('Skills with disable-model-invocation:true:', all.filter(r => r.dmi).length);
console.log('Total footprint (desc+wtu, ALL):', total, 'chars');
console.log('Total footprint (model-listed only):', totalListed, 'chars');
console.log('Est tokens (~4 chars/tok):', Math.round(totalListed / 4));

console.log('\n=== BUDGET (skillListingBudgetFraction=0.01, ctx=200k) ===');
const ctx = 200000;
const budgetTokens = ctx * 0.01;           // 2000 tokens
const budgetCharsApprox = budgetTokens * 4; // ~8000 chars
console.log('1% of 200k ctx =', budgetTokens, 'tokens  (~', budgetCharsApprox, 'chars @4c/tok)');
console.log('Model-listed footprint vs char-budget:', totalListed, '/', budgetCharsApprox,
            '=>', (totalListed > budgetCharsApprox ? 'OVERFLOW' : 'under budget'),
            `(${(totalListed / budgetCharsApprox * 100).toFixed(1)}%)`);
console.log('Est listed tokens vs token-budget:', Math.round(totalListed / 4), '/', budgetTokens,
            '=>', (totalListed / 4 > budgetTokens ? 'OVERFLOW' : 'under budget'));

console.log('\n=== PER-ENTRY CAP (skillListingMaxDescChars=' + CAP + ') ===');
console.log('Skills whose desc+wtu EXCEEDS cap (tail silently truncated):', overCap.length);
for (const r of overCap) {
  console.log('  ', r.footprint, r.source, r.name, '(+' + (r.footprint - CAP) + ' over)');
}
console.log('PRISM-authored over cap:', prismOverCap.length, prismOverCap.map(r => r.name).join(', ') || '(none)');
