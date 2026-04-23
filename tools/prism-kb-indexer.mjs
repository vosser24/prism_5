#!/usr/bin/env node
// PRISM KB Indexer (v2.1.25 Phase 1.1)
//
// Scans all local knowledge sources (agents, plugin skills, PRISM skills,
// slash commands, project rules) and writes a unified router index at
// ~/.claude/.prism-kb-index.json.
//
// Entry schema:
//   { id, type, source, name, description, triggers[], keywords_top10[],
//     body_path, body_bytes, invoke_hint }
//
// Usage:
//   node ~/.claude/tools/prism-kb-indexer.mjs [--force] [--json-stats]

import {readFileSync, readdirSync, statSync, existsSync, writeFileSync} from 'fs';
import {join, relative} from 'path';
import {classifyEntry} from './prism-kb-domains.mjs';

function withDomain(entry) {
  const c = classifyEntry(entry);
  entry.domain = c.domain;
  entry.domain_confidence = c.confidence;
  entry.domain_reason = c.reason;
  return entry;
}

const H = process.env.HOME || process.env.USERPROFILE;
const CLAUDE_DIR = join(H, '.claude');
const INDEX_PATH = join(CLAUDE_DIR, '.prism-kb-index.json');

const STOPWORDS = new Set([
  'a','an','the','and','or','but','if','then','else','to','for','of','on','in',
  'at','by','as','is','it','be','this','that','these','those','with','from','use',
  'when','user','says','into','out','via','will','not','you','your','i','my','we',
  'our','me','us','can','should','would','could','may','might','must','shall','so',
  'also','just','very','any','all','each','every','some','more','most','than',
  'which','what','who','whom','whose','how','why','where','about','over','under'
]);

function readHead(path, bytes = 4096) {
  try { return readFileSync(path, 'utf-8').slice(0, bytes); } catch { return ''; }
}

function parseYamlFrontMatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {raw: '', fields: {}};
  const raw = m[1];
  const fields = {};
  const lines = raw.split(/\r?\n/);
  let key = null, buf = [];
  for (const line of lines) {
    const top = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (top) {
      if (key !== null) fields[key] = buf.join(' ').trim();
      key = top[1];
      buf = [top[2]];
    } else if (key !== null) {
      buf.push(line.trim());
    }
  }
  if (key !== null) fields[key] = buf.join(' ').trim();
  return {raw, fields};
}

function extractTriggers(desc) {
  if (!desc) return [];
  const triggers = new Set();
  const quotePattern = /["\u201C\u201D]([^"\u201C\u201D]{3,80})["\u201C\u201D]/g;
  let m;
  while ((m = quotePattern.exec(desc)) !== null) triggers.add(m[1].toLowerCase().trim());
  const useWhenRe = /\bUse (when|for|in) ([^.]{8,140})/ig;
  while ((m = useWhenRe.exec(desc)) !== null) {
    const phrase = m[2].toLowerCase().trim();
    if (phrase && phrase.length < 140) triggers.add(phrase);
  }
  return Array.from(triggers).slice(0, 20);
}

function extractKeywords(text, topN = 10) {
  if (!text) return [];
  const tokens = text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
  const counts = new Map();
  for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([w]) => w);
}

function walkFiles(root, predicate, maxDepth = 6) {
  const out = [];
  const inner = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = readdirSync(dir, {withFileTypes: true}); } catch { return; }
    for (const ent of entries) {
      if (ent.name.startsWith('.') && ent.name !== '.claude') continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) inner(p, depth + 1);
      else if (ent.isFile() && predicate(p, ent.name)) out.push(p);
    }
  };
  if (existsSync(root)) inner(root, 0);
  return out;
}

function scanAgents() {
  const root = join(CLAUDE_DIR, 'agents');
  const files = walkFiles(root, (_p, name) => name.endsWith('.md'));
  const out = [];
  for (const f of files) {
    const head = readHead(f);
    const {fields} = parseYamlFrontMatter(head);
    const name = fields.name || relative(root, f).replace(/\.md$/, '').replace(/[/\\]/g, ':');
    const description = (fields.description || '').slice(0, 800);
    const model = fields.model || '';
    let bytes = 0; try { bytes = statSync(f).size; } catch {}
    out.push(withDomain({
      id: `agent:${name}`,
      type: 'agent',
      source: 'local:agents',
      name,
      description,
      triggers: extractTriggers(description),
      keywords_top10: extractKeywords(description),
      body_path: f,
      body_bytes: bytes,
      invoke_hint: `Agent(subagent_type='${name}'${model ? `, model='${model}'` : ''})`,
      model,
    }));
  }
  return out;
}

function scanCommands() {
  const root = join(CLAUDE_DIR, 'commands');
  const files = walkFiles(root, (_p, name) => name.endsWith('.md'));
  const out = [];
  for (const f of files) {
    const head = readHead(f);
    const {fields} = parseYamlFrontMatter(head);
    const name = fields.name || relative(root, f).replace(/\.md$/, '').replace(/[/\\]/g, ':');
    const description = (fields.description || '').slice(0, 800);
    let bytes = 0; try { bytes = statSync(f).size; } catch {}
    out.push(withDomain({
      id: `command:${name}`,
      type: 'command',
      source: 'local:commands',
      name,
      description,
      triggers: extractTriggers(description),
      keywords_top10: extractKeywords(description),
      body_path: f,
      body_bytes: bytes,
      invoke_hint: `/${name}`,
    }));
  }
  return out;
}

function scanPRISMSkills() {
  const root = join(CLAUDE_DIR, 'skills');
  const files = walkFiles(root, (_p, name) => name === 'SKILL.md');
  const out = [];
  for (const f of files) {
    const head = readHead(f);
    const {fields} = parseYamlFrontMatter(head);
    const name = fields.name || '';
    if (!name) continue;
    const description = (fields.description || '').slice(0, 800);
    let bytes = 0; try { bytes = statSync(f).size; } catch {}
    out.push(withDomain({
      id: `skill:prism:${name}`,
      type: 'skill',
      source: 'local:prism-skills',
      name,
      description,
      triggers: extractTriggers(description),
      keywords_top10: extractKeywords(description),
      body_path: f,
      body_bytes: bytes,
      invoke_hint: `Skill({skill:'${name}'})`,
    }));
  }
  return out;
}

function scanPluginSkills(enabledMap) {
  const cacheRoot = join(CLAUDE_DIR, 'plugins', 'cache');
  if (!existsSync(cacheRoot)) return [];
  let orgs;
  try {
    orgs = readdirSync(cacheRoot).filter(d => !d.startsWith('temp_') && !d.startsWith('.'))
      .filter(d => { try { return statSync(join(cacheRoot, d)).isDirectory(); } catch { return false; }});
  } catch { return []; }

  const out = [];
  for (const org of orgs) {
    const orgDir = join(cacheRoot, org);
    let plugins;
    try { plugins = readdirSync(orgDir); } catch { continue; }
    for (const p of plugins) {
      const pluginDir = join(orgDir, p);
      const s = (() => { try { return statSync(pluginDir); } catch { return null; } })();
      if (!s || !s.isDirectory()) continue;
      let versions;
      try { versions = readdirSync(pluginDir).filter(v => { try { return statSync(join(pluginDir, v)).isDirectory(); } catch { return false; }}); } catch { continue; }
      versions.sort((a, b) => {
        const ap = a.split('.').map(n => parseInt(n, 10) || 0);
        const bp = b.split('.').map(n => parseInt(n, 10) || 0);
        for (let i = 0; i < Math.max(ap.length, bp.length); i++) { if ((ap[i] || 0) !== (bp[i] || 0)) return (ap[i] || 0) - (bp[i] || 0); }
        return 0;
      });
      if (!versions.length) continue;
      const latest = versions[versions.length - 1];
      const skillsDir = join(pluginDir, latest, 'skills');
      if (!existsSync(skillsDir)) continue;
      const skillFiles = walkFiles(skillsDir, (_p, name) => name === 'SKILL.md');
      const pluginKey = `${p}@${org}`;
      const enabled = enabledMap.get(pluginKey) === true;
      for (const f of skillFiles) {
        const head = readHead(f);
        const {fields} = parseYamlFrontMatter(head);
        const name = fields.name || '';
        if (!name) continue;
        const description = (fields.description || '').slice(0, 800);
        let bytes = 0; try { bytes = statSync(f).size; } catch {}
        out.push(withDomain({
          id: `skill:${p}:${name}`,
          type: 'skill',
          source: `plugin:${pluginKey}`,
          plugin_enabled: enabled,
          name,
          description,
          triggers: extractTriggers(description),
          keywords_top10: extractKeywords(description),
          body_path: f,
          body_bytes: bytes,
          invoke_hint: enabled ? `Skill({skill:'${p}:${name}'})` : `Skill({skill:'${p}:${name}'}) — plugin currently disabled, may require /plugin enable ${pluginKey}, OR read body_path directly`,
        }));
      }
    }
  }
  return out;
}

function scanRules(projectRoot) {
  const out = [];
  const globalBase = join(CLAUDE_DIR, 'rules');
  const projectBase = join(projectRoot, '.claude', 'rules');
  for (const [base, scope] of [[globalBase, 'global'], [projectBase, 'project']]) {
    const files = walkFiles(base, (_p, name) => name.endsWith('.md'));
    for (const f of files) {
      const head = readHead(f);
      const description = head.replace(/^---[\s\S]*?---/, '').replace(/\s+/g, ' ').trim().slice(0, 400);
      const name = relative(base, f).replace(/\.md$/, '').replace(/[/\\]/g, ':');
      let bytes = 0; try { bytes = statSync(f).size; } catch {}
      out.push(withDomain({
        id: `rule:${scope}:${name}`,
        type: 'rule',
        source: `local:${scope}-rules`,
        name,
        description,
        triggers: [],
        keywords_top10: extractKeywords(description),
        body_path: f,
        body_bytes: bytes,
        invoke_hint: 'Reference document — read via Read tool if relevant',
      }));
    }
  }
  return out;
}

function loadEnabledPlugins() {
  try {
    const s = JSON.parse(readFileSync(join(CLAUDE_DIR, 'settings.json'), 'utf-8'));
    return new Map(Object.entries(s.enabledPlugins || {}));
  } catch { return new Map(); }
}

function shouldRebuild(oldIndex, sourceMtimeMax) {
  if (!oldIndex) return true;
  if (oldIndex.version !== 2) return true;
  if (!oldIndex.source_mtime_max) return true;
  return sourceMtimeMax > oldIndex.source_mtime_max;
}

function collectSourceMtimeMax(projectRoot) {
  let max = 0;
  const candidates = [
    join(CLAUDE_DIR, 'agents'),
    join(CLAUDE_DIR, 'commands'),
    join(CLAUDE_DIR, 'skills'),
    join(CLAUDE_DIR, 'plugins', 'cache'),
    join(CLAUDE_DIR, 'rules'),
    join(projectRoot, '.claude', 'rules'),
  ];
  for (const root of candidates) {
    if (!existsSync(root)) continue;
    const files = walkFiles(root, (_p, name) => name.endsWith('.md'));
    for (const f of files) {
      try { const m = Math.floor(statSync(f).mtimeMs / 1000); if (m > max) max = m; } catch {}
    }
  }
  return max;
}

function build({force = false} = {}) {
  const t0 = Date.now();
  const projectRoot = process.cwd();
  const sourceMtimeMax = collectSourceMtimeMax(projectRoot);

  let oldIndex = null;
  if (!force && existsSync(INDEX_PATH)) {
    try { oldIndex = JSON.parse(readFileSync(INDEX_PATH, 'utf-8')); } catch {}
  }
  if (!force && !shouldRebuild(oldIndex, sourceMtimeMax)) {
    return {
      rebuilt: false,
      source_mtime_max: sourceMtimeMax,
      entry_count: oldIndex?.entry_count || 0,
      elapsed_ms: Date.now() - t0,
    };
  }

  const enabledMap = loadEnabledPlugins();
  const entries = [
    ...scanAgents(),
    ...scanCommands(),
    ...scanPRISMSkills(),
    ...scanPluginSkills(enabledMap),
    ...scanRules(projectRoot),
  ];

  const index = {
    version: 2,
    built_at: new Date().toISOString(),
    source_mtime_max: sourceMtimeMax,
    entry_count: entries.length,
    by_type: entries.reduce((a, e) => { a[e.type] = (a[e.type] || 0) + 1; return a; }, {}),
    by_domain: entries.reduce((a, e) => { const d = e.domain || 'misc'; a[d] = (a[d] || 0) + 1; return a; }, {}),
    entries,
  };
  writeFileSync(INDEX_PATH, JSON.stringify(index));

  return {
    rebuilt: true,
    source_mtime_max: sourceMtimeMax,
    entry_count: entries.length,
    by_type: index.by_type,
    elapsed_ms: Date.now() - t0,
    written_bytes: JSON.stringify(index).length,
  };
}

const args = process.argv.slice(2);
const force = args.includes('--force');
const jsonStats = args.includes('--json-stats');
const invokedDirectly = import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('prism-kb-indexer.mjs');

if (invokedDirectly) {
  const stats = build({force});
  if (jsonStats) {
    process.stdout.write(JSON.stringify(stats, null, 2));
  } else {
    if (stats.rebuilt) {
      console.log(`PRISM KB index rebuilt in ${stats.elapsed_ms}ms`);
      console.log(`Entries: ${stats.entry_count} (${Object.entries(stats.by_type).map(([t, n]) => `${t}:${n}`).join(', ')})`);
      console.log(`Written: ${INDEX_PATH} (${stats.written_bytes.toLocaleString()} bytes)`);
    } else {
      console.log(`PRISM KB index up to date (sources unchanged since last build, ${stats.entry_count} entries).`);
    }
  }
}

export { build, extractTriggers, extractKeywords, parseYamlFrontMatter, scanAgents, scanCommands, scanPRISMSkills, scanPluginSkills, scanRules };
