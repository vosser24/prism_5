#!/usr/bin/env node
// PRISM Context-Audit Tool (v2.1.25 Gap 1)
//
// Measures the SessionStart token tax from active plugins by scanning each
// plugin's SKILL.md files and summing the YAML front-matter `description`
// field length (that's what Claude Code loads on session start; the body
// loads lazily only when the skill is invoked).
//
// Usage:
//   node ~/.claude/tools/prism-context-audit.mjs              # human-readable
//   node ~/.claude/tools/prism-context-audit.mjs --json       # machine-readable
//   node ~/.claude/tools/prism-context-audit.mjs --cache      # also write cache file

import {readFileSync, readdirSync, statSync, existsSync, writeFileSync} from 'fs';
import {join} from 'path';

const H = process.env.HOME || process.env.USERPROFILE;
const SETTINGS = join(H, '.claude', 'settings.json');
const PLUGIN_CACHE = join(H, '.claude', 'plugins', 'cache');
const CACHE_OUT = join(H, '.claude', '.prism-context-audit.json');

const OPUS_INPUT_PER_M_USD = 15;
const CHARS_PER_TOKEN = 4;
const NOTABLE_TOKEN_THRESHOLD = 5000;

function readSettingsEnabledPlugins() {
  try {
    const raw = JSON.parse(readFileSync(SETTINGS, 'utf-8'));
    return raw.enabledPlugins || {};
  } catch {
    return {};
  }
}

function latestVersionDir(orgDir, pluginName) {
  const base = join(orgDir, pluginName);
  if (!existsSync(base)) return null;
  let dirs;
  try { dirs = readdirSync(base); } catch { return null; }
  const versions = dirs
    .filter(d => {
      try { return statSync(join(base, d)).isDirectory(); } catch { return false; }
    })
    .sort((a, b) => {
      const ap = a.split('.').map(n => parseInt(n, 10) || 0);
      const bp = b.split('.').map(n => parseInt(n, 10) || 0);
      for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
        if ((ap[i] || 0) !== (bp[i] || 0)) return (ap[i] || 0) - (bp[i] || 0);
      }
      return 0;
    });
  return versions.length ? join(base, versions[versions.length - 1]) : null;
}

function findSkillMdFiles(root, maxDepth = 5) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = readdirSync(dir, {withFileTypes: true}); } catch { return; }
    for (const ent of entries) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p, depth + 1);
      else if (ent.isFile() && ent.name === 'SKILL.md') out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

function extractDescriptionLen(skillPath) {
  try {
    const fd = readFileSync(skillPath, {encoding: 'utf-8', flag: 'r'});
    const head = fd.slice(0, 2048);
    const fm = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) return 0;
    const body = fm[1];
    const m = body.match(/^description:\s*(.*)/m);
    if (!m) return 0;
    let desc = m[1].trim();
    if (desc === '|' || desc === '>' || desc === '') {
      const lines = body.split(/\r?\n/);
      const startIdx = lines.findIndex(l => /^description:/.test(l));
      const collected = [];
      for (let i = startIdx + 1; i < lines.length; i++) {
        const l = lines[i];
        if (/^\S/.test(l) && /:/.test(l)) break;
        collected.push(l.trim());
      }
      desc = collected.join(' ').trim();
    }
    return desc.length;
  } catch {
    return 0;
  }
}

function auditPlugin(orgDir, pluginName, orgName, enabledMap) {
  const versionDir = latestVersionDir(orgDir, pluginName);
  if (!versionDir) return null;
  const skillsDir = join(versionDir, 'skills');
  if (!existsSync(skillsDir)) return null;
  const skillFiles = findSkillMdFiles(skillsDir);
  if (!skillFiles.length) return null;
  let totalChars = 0;
  for (const f of skillFiles) totalChars += extractDescriptionLen(f);
  const tokens = Math.round(totalChars / CHARS_PER_TOKEN);
  const pluginKey = `${pluginName}@${orgName}`;
  const enabledRaw = enabledMap.get(pluginKey);
  return {
    org: orgName,
    name: pluginName,
    enabled: enabledRaw === true,
    skills: skillFiles.length,
    tokens,
  };
}

function runAudit() {
  const enabledMap = new Map(Object.entries(readSettingsEnabledPlugins()));
  let orgs = [];
  try {
    orgs = readdirSync(PLUGIN_CACHE)
      .filter(d => !d.startsWith('temp_') && !d.startsWith('.'))
      .filter(d => {
        try { return statSync(join(PLUGIN_CACHE, d)).isDirectory(); } catch { return false; }
      });
  } catch {}

  const plugins = [];
  for (const org of orgs) {
    const orgDir = join(PLUGIN_CACHE, org);
    let pluginDirs;
    try { pluginDirs = readdirSync(orgDir); } catch { continue; }
    for (const p of pluginDirs) {
      const stat = (() => { try { return statSync(join(orgDir, p)); } catch { return null; } })();
      if (!stat || !stat.isDirectory()) continue;
      const info = auditPlugin(orgDir, p, org, enabledMap);
      if (info) plugins.push(info);
    }
  }

  const enabledPlugins = plugins.filter(p => p.enabled);
  const total = enabledPlugins.reduce((s, p) => s + p.tokens, 0);
  const opusCost = total * OPUS_INPUT_PER_M_USD / 1_000_000;
  enabledPlugins.sort((a, b) => b.tokens - a.tokens);

  let top = null;
  if (total >= NOTABLE_TOKEN_THRESHOLD && enabledPlugins.length) {
    const heavy = enabledPlugins[0];
    if (heavy.tokens >= 2000) {
      top = `/plugin disable ${heavy.name}@${heavy.org} (save ~${heavy.tokens}t/session \u2248 $${(heavy.tokens * OPUS_INPUT_PER_M_USD / 1_000_000).toFixed(3)} on Opus input)`;
    }
  }

  return {
    measured_at: new Date().toISOString(),
    total_tokens_est: total,
    total_cost_opus_usd: Number(opusCost.toFixed(4)),
    plugins: enabledPlugins,
    all_plugins: plugins,
    top_suggestion: top,
  };
}

const args = process.argv.slice(2);
const wantJson = args.includes('--json');
const writeCache = args.includes('--cache');

const result = runAudit();

if (writeCache) {
  try { writeFileSync(CACHE_OUT, JSON.stringify(result, null, 2)); } catch {}
}

if (wantJson) {
  process.stdout.write(JSON.stringify(result, null, 2));
} else {
  console.log(`PRISM SessionStart context audit — measured at ${result.measured_at}`);
  console.log(`Total tax (enabled plugins only): ~${result.total_tokens_est.toLocaleString('en-US')} tokens (~$${result.total_cost_opus_usd} per session on Opus input)`);
  console.log('');
  console.log('Per-plugin breakdown:');
  for (const p of result.plugins) {
    console.log(`  ${p.org.padEnd(30)} ${p.name.padEnd(30)} ${String(p.skills).padStart(4)} skills  ~${String(p.tokens).padStart(6)} tokens`);
  }
  console.log('');
  const disabled = result.all_plugins.filter(q => !q.enabled);
  if (disabled.length) {
    console.log('Disabled in settings.json (no tax):');
    for (const p of disabled) {
      console.log(`  ${p.org}/${p.name}  ${p.skills} skills  ~${p.tokens} tokens  (would cost if enabled)`);
    }
    console.log('');
  }
  if (result.top_suggestion) {
    console.log('Top optimization: ' + result.top_suggestion);
  } else {
    console.log('No optimization recommended — SessionStart tax is within acceptable range.');
  }
}
