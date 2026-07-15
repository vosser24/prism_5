#!/usr/bin/env node
// prism-knowledge-index — builds and maintains a compact index of PRISM
// adjudications + lessons for fast LLM context loading.
//
// Subcommands:
//   rebuild [--root <dir>]
//       Full scan of docs/prism/adjudications/*.md and docs/prism/lessons/*.md.
//       Writes .claude/references/knowledge-index.md and
//       .claude/references/.knowledge-manifest.json. Exit 0.
//
//   append --type <adjudication|lesson> --file <filename-or-path> [--root <dir>]
//       Upsert one file into the existing index + manifest. Idempotent. Exit 0.
//
//   delta [--root <dir>] [--json]
//       Hash all corpus files vs manifest; emit digest of added/changed/removed.
//       Incrementally updates index + manifest if any delta found.
//       ALWAYS exits 0 (fail-open — safe to run at session start).
//
// Conventions mirror tools/prism-clean.mjs:
//   - ESM, dep-free, manual arg parsing
//   - atomic writes: write to .tmp then rename
//   - HOME: process.env.HOME || process.env.USERPROFILE
//   - die(msg, code) => process.exit(code)

import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readdirSync, readFileSync, renameSync,
        statSync, writeFileSync} from 'node:fs';
import {basename, dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {argv, exit, stderr, stdout} from 'node:process';
import {fileURLToPath, pathToFileURL} from 'node:url';

// Shared delta module — imported lazily in cmdDelta to avoid top-level await.
// applyDelta(root) → {added, changed, removed}  (also self-heals index+manifest+kwmap)
let _deltaLib = null;
async function getDeltaLib() {
  if (_deltaLib) return _deltaLib;
  const deltaPath = join(dirname(fileURLToPath(import.meta.url)), 'lib', 'knowledge-delta.mjs');
  _deltaLib = await import(pathToFileURL(deltaPath).href);
  return _deltaLib;
}

// Import tokenize from prism-router (reuse, do not reimplement).
// Dynamic import deferred to buildKeywordMap so CLI startup stays sync.
let _tokenize = null;
async function getTokenize() {
  if (_tokenize) return _tokenize;
  try {
    const routerPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'lib', 'prism-router.mjs');
    // pathToFileURL required on Windows — bare Win32 paths are rejected by import().
    const {tokenize} = await import(pathToFileURL(routerPath).href);
    _tokenize = tokenize;
  } catch {
    // Fallback: simple split if router unavailable (should never happen in practice)
    _tokenize = (text) => {
      if (!text) return [];
      return text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(t => t.length >= 3);
    };
  }
  return _tokenize;
}

// ─────────────────────────────────────────────── arg parsing ────────────────

const args = argv.slice(2);
const opts = {root: process.cwd()};
const positional = [];
const named = {};

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--root') opts.root = resolve(args[++i]);
  else if (a === '--type') named.type = args[++i];
  else if (a === '--file') named.file = args[++i];
  else if (a === '--json') named.json = true;
  else if (a === '-h' || a === '--help' || a === 'help') usage();
  else positional.push(a);
}

const cmd = positional.shift();
if (!cmd) usage(1);

function usage(code = 0) {
  stdout.write(`Usage: prism-knowledge-index <command> [options]

Commands:
  rebuild [--root <dir>]
  append --type <adjudication|lesson> --file <filename-or-path> [--root <dir>]
  delta [--root <dir>] [--json]
`);
  exit(code);
}

// ─────────────────────────────────────────────── helpers ────────────────────

function die(msg, code = 1) {
  stderr.write(msg + '\n');
  exit(code);
}

function atomicWrite(path, body) {
  const tmp = path + '.tmp';
  writeFileSync(tmp, body, 'utf8');
  renameSync(tmp, path);
}

function sha1(content) {
  return createHash('sha1').update(content).digest('hex');
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, {recursive: true});
}

// ─────────────────────────────────────────────── parsing ────────────────────

// Parse adjudication filename: D001-some-slug.md  →  {dNum: 1, slug: 'some-slug', ref: 'D001'}
const ADJ_FILE_RE = /^D(\d{3,})-(.+)\.md$/;

function parseAdjFilename(name) {
  const m = name.match(ADJ_FILE_RE);
  if (!m) return null;
  return {dNum: parseInt(m[1], 10), slug: m[2], ref: 'D' + m[1]};
}

// Parse lesson filename: YYYY-MM-DD-<anything>.md  →  ref = 'YYYY-MM-DD'
// Non-dated: ref = filename without .md
const LESSON_DATE_RE = /^(\d{4}-\d{2}-\d{2})/;

function parseLessonFilename(name) {
  const stem = name.replace(/\.md$/, '');
  const m = stem.match(LESSON_DATE_RE);
  const ref = m ? m[1] : stem;
  return {ref};
}

// Extract first `# ` H1 line text from file content
function extractTitle(content, fallback) {
  for (const line of content.split('\n')) {
    const m = line.match(/^#\s+(.+)/);
    if (m) return m[1].trim();
  }
  return fallback;
}

// Extract **Status:** value from content
function extractStatus(content) {
  const m = content.match(/\*\*Status:\*\*\s*(\S+)/);
  return m ? m[1] : null;
}

// Extract **Rule:** value from content (one-line imperative in header)
function extractRule(content) {
  const m = content.match(/\*\*Rule:\*\*\s*(.+)/);
  return m ? m[1].trim() : '';
}

// ─────────────────────────────────────────────── corpus scan ────────────────

function scanAdjudications(root) {
  const dir = join(root, 'docs', 'prism', 'adjudications');
  if (!existsSync(dir)) return [];
  const results = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const parsed = parseAdjFilename(name);
    if (!parsed) continue;
    const absPath = join(dir, name);
    const content = readFileSync(absPath, 'utf8');
    const relPath = relative(root, absPath).replace(/\\/g, '/');
    results.push({
      absPath,
      relPath,
      name,
      dNum: parsed.dNum,
      ref: parsed.ref,
      slug: parsed.slug,
      type: 'adjudication',
      title: extractTitle(content, parsed.slug),
      status: extractStatus(content),
      rule: extractRule(content),
      hash: sha1(content),
      content,
    });
  }
  results.sort((a, b) => a.dNum - b.dNum);
  return results;
}

function scanLessons(root) {
  const dir = join(root, 'docs', 'prism', 'lessons');
  if (!existsSync(dir)) return [];
  const results = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const parsed = parseLessonFilename(name);
    const absPath = join(dir, name);
    const content = readFileSync(absPath, 'utf8');
    const relPath = relative(root, absPath).replace(/\\/g, '/');
    // Derive date for sorting: YYYY-MM-DD prefix in filename, else mtime
    const dateMatch = name.match(LESSON_DATE_RE);
    const sortDate = dateMatch
      ? dateMatch[1]
      : new Date(statSync(absPath).mtime).toISOString().slice(0, 10);
    results.push({
      absPath,
      relPath,
      name,
      ref: parsed.ref,
      type: 'lesson',
      title: extractTitle(content, name.replace(/\.md$/, '')),
      rule: extractRule(content),
      sortDate,
      hash: sha1(content),
      content,
    });
  }
  // Sort descending by date
  results.sort((a, b) => (a.sortDate > b.sortDate ? -1 : a.sortDate < b.sortDate ? 1 : 0));
  return results;
}

// ─────────────────────────────────────────────── output paths ───────────────

function getOutputPaths(root) {
  const refDir = join(root, '.claude', 'references');
  return {
    refDir,
    indexPath: join(refDir, 'knowledge-index.md'),
    manifestPath: join(refDir, '.knowledge-manifest.json'),
    keywordMapPath: join(refDir, '.knowledge-keyword-map.json'),
  };
}

// ─────────────────────────────────────────────── keyword map ─────────────────

// Extract **Triggers:** value from content → array of trigger strings
function extractTriggers(content) {
  const m = content.match(/\*\*Triggers:\*\*\s*(.+)/);
  if (!m) return [];
  return m[1].split(',').map(s => s.trim()).filter(Boolean);
}

// Build and atomically write .knowledge-keyword-map.json
// entries: array of {ref, type, title, slug?, relPath, content}
async function buildKeywordMap(entries, refDir, keywordMapPath, now) {
  try {
    const tokenize = await getTokenize();
    const mapEntries = [];
    for (const e of entries) {
      const seedText = (e.title || '') + ' ' + (e.slug || '') + ' ' + (e.ref || '');
      const tokens = [...new Set(tokenize(seedText))];
      const triggers = extractTriggers(e.content || '');
      mapEntries.push({
        ref: e.ref,
        type: e.type,
        title: e.title || '',
        relPath: e.relPath || '',
        rule: e.rule || '',
        status: e.status || '',
        tokens,
        triggers,
      });
    }
    const map = {
      version: 1,
      generated_at: now || new Date().toISOString(),
      entries: mapEntries,
    };
    atomicWrite(keywordMapPath, JSON.stringify(map, null, 2) + '\n');
  } catch {
    // Fail-open: keyword map is advisory — never break rebuild/append
  }
}

// ─────────────────────────────────────────────── render index ───────────────

function renderIndex(adjudications, lessons, now) {
  const date = now ? now.slice(0, 10) : new Date().toISOString().slice(0, 10);
  const lines = [
    '# PRISM knowledge index',
    '<!-- Generated by tools/prism-knowledge-index.mjs. Do not hand-edit. Rebuild: /prism-discover (knowledge); self-updates via /prism-clean append + session-start delta. -->',
    `_Last rebuilt: ${date} · ${adjudications.length} adjudications, ${lessons.length} lessons_`,
    '',
    '## Adjudications (locked design decisions)',
  ];

  if (adjudications.length === 0) {
    lines.push('_(none yet)_');
  } else {
    for (const a of adjudications) {
      const statusPart = a.status ? ` _(${a.status})_` : '';
      lines.push(`- [[${a.ref}]] ${a.slug} — ${a.title}${statusPart}`);
    }
  }

  lines.push('');
  lines.push('## Lessons');

  if (lessons.length === 0) {
    lines.push('_(none yet)_');
  } else {
    for (const l of lessons) {
      lines.push(`- [[lesson:${l.ref}]] ${l.title}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

// ─────────────────────────────────────────────── render manifest ─────────────

function renderManifest(allEntries, now) {
  const files = {};
  for (const e of allEntries) {
    const entry = {hash: e.hash, type: e.type, ref: e.ref, title: e.title};
    if (e.type === 'adjudication' && e.status) entry.status = e.status;
    if (e.rule) entry.rule = e.rule;
    files[e.relPath] = entry;
  }
  return {
    version: 1,
    generated_at: now || new Date().toISOString(),
    files,
  };
}

// ─────────────────────────────────────────────── load manifest ───────────────

function loadManifest(manifestPath) {
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────── rebuild ────────────────────

async function cmdRebuild(root) {
  const {refDir, indexPath, manifestPath, keywordMapPath} = getOutputPaths(root);
  ensureDir(refDir);

  const adjudications = scanAdjudications(root);
  const lessons = scanLessons(root);

  const now = new Date().toISOString();
  const indexBody = renderIndex(adjudications, lessons, now);
  atomicWrite(indexPath, indexBody);

  const allEntries = [...adjudications, ...lessons];
  const manifest = renderManifest(allEntries, now);
  atomicWrite(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  await buildKeywordMap(allEntries, refDir, keywordMapPath, now);

  stdout.write(
    `Knowledge index rebuilt: ${adjudications.length} adjudications, ` +
    `${lessons.length} lessons → ${indexPath}\n`
  );
}

// ─────────────────────────────────────────────── append ─────────────────────

// Parse a single file into an entry object
function parseSingleFile(root, type, filePath) {
  // Resolve: if absolute use as-is; if just a filename look in the corpus dir
  let absPath;
  if (isAbsolute(filePath)) {
    absPath = filePath;
  } else {
    const corpusDir = type === 'adjudication'
      ? join(root, 'docs', 'prism', 'adjudications')
      : join(root, 'docs', 'prism', 'lessons');
    absPath = join(corpusDir, filePath);
  }

  if (!existsSync(absPath)) die(`file not found: ${absPath}`, 1);

  const name = basename(absPath);
  const content = readFileSync(absPath, 'utf8');
  const relPath = relative(root, absPath).replace(/\\/g, '/');

  if (type === 'adjudication') {
    const parsed = parseAdjFilename(name);
    if (!parsed) die(`filename does not match D###-<slug>.md: ${name}`, 1);
    return {
      absPath, relPath, name,
      dNum: parsed.dNum, ref: parsed.ref, slug: parsed.slug,
      type: 'adjudication',
      title: extractTitle(content, parsed.slug),
      status: extractStatus(content),
      rule: extractRule(content),
      hash: sha1(content),
      content,
    };
  } else {
    const parsed = parseLessonFilename(name);
    const dateMatch = name.match(LESSON_DATE_RE);
    const sortDate = dateMatch
      ? dateMatch[1]
      : new Date(statSync(absPath).mtime).toISOString().slice(0, 10);
    return {
      absPath, relPath, name,
      ref: parsed.ref,
      type: 'lesson',
      title: extractTitle(content, name.replace(/\.md$/, '')),
      rule: extractRule(content),
      sortDate,
      hash: sha1(content),
      content,
    };
  }
}

// Upsert one adjudication line into the ## Adjudications section (sorted)
function upsertAdjudicationLine(indexBody, entry) {
  const newLine = `- [[${entry.ref}]] ${entry.slug} — ${entry.title}` +
    (entry.status ? ` _(${entry.status})_` : '');

  const lines = indexBody.replace(/\r\n/g, '\n').split('\n');
  const sectionStart = lines.findIndex(l => l.startsWith('## Adjudications'));
  const sectionEnd = lines.findIndex((l, i) => i > sectionStart && l.startsWith('## '));

  // Collect existing adjudication lines in the section
  const end = sectionEnd === -1 ? lines.length : sectionEnd;
  const before = lines.slice(0, sectionStart + 1);
  const sectionLines = lines.slice(sectionStart + 1, end);
  const after = lines.slice(end);

  // Filter out the existing line for this ref (idempotent)
  const refPattern = new RegExp(`^- \\[\\[${entry.ref}\\]\\]`);
  const existingAdj = sectionLines.filter(l => /^- \[\[D\d/.test(l) && !refPattern.test(l));

  // Build new line list with correct sorted position
  const allAdj = [...existingAdj, newLine];
  allAdj.sort((a, b) => {
    const ma = a.match(/\[\[D(\d+)\]\]/);
    const mb = b.match(/\[\[D(\d+)\]\]/);
    const na = ma ? parseInt(ma[1], 10) : 0;
    const nb = mb ? parseInt(mb[1], 10) : 0;
    return na - nb;
  });

  // Preserve non-adjudication lines (like "_(none yet)_") but drop them once we have real entries
  const nonAdj = sectionLines.filter(l => !/^- \[\[D\d/.test(l) && l !== '_(none yet)_');

  return [...before, ...nonAdj, ...allAdj, '', ...after].join('\n');
}

// Upsert one lesson line into the ## Lessons section (sorted descending by ref/date)
function upsertLessonLine(indexBody, entry) {
  const newLine = `- [[lesson:${entry.ref}]] ${entry.title}`;

  const lines = indexBody.replace(/\r\n/g, '\n').split('\n');
  const sectionStart = lines.findIndex(l => l.startsWith('## Lessons'));
  if (sectionStart === -1) {
    // No lessons section found — append
    return indexBody.trimEnd() + '\n\n## Lessons\n' + newLine + '\n';
  }
  const sectionEnd = lines.findIndex((l, i) => i > sectionStart && l.startsWith('## '));
  const end = sectionEnd === -1 ? lines.length : sectionEnd;
  const before = lines.slice(0, sectionStart + 1);
  const sectionLines = lines.slice(sectionStart + 1, end);
  const after = lines.slice(end);

  const refPattern = new RegExp(`^- \\[\\[lesson:${escapeRegex(entry.ref)}\\]\\]`);
  const existingLessons = sectionLines.filter(l => /^- \[\[lesson:/.test(l) && !refPattern.test(l));

  const allLessons = [...existingLessons, newLine];
  allLessons.sort((a, b) => {
    const ma = a.match(/\[\[lesson:([^\]]+)\]\]/);
    const mb = b.match(/\[\[lesson:([^\]]+)\]\]/);
    const ra = ma ? ma[1] : '';
    const rb = mb ? mb[1] : '';
    return ra > rb ? -1 : ra < rb ? 1 : 0;
  });

  const nonLesson = sectionLines.filter(l => !/^- \[\[lesson:/.test(l) && l !== '_(none yet)_');

  return [...before, ...nonLesson, ...allLessons, '', ...after].join('\n');
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function cmdAppend(root, type, filePath) {
  if (!type || !['adjudication', 'lesson'].includes(type)) {
    die('append requires --type <adjudication|lesson>', 1);
  }
  if (!filePath) die('append requires --file <filename-or-path>', 1);

  const {refDir, indexPath, manifestPath, keywordMapPath} = getOutputPaths(root);
  ensureDir(refDir);

  const entry = parseSingleFile(root, type, filePath);
  const now = new Date().toISOString();

  // Load or bootstrap index
  let indexBody = existsSync(indexPath)
    ? readFileSync(indexPath, 'utf8')
    : renderIndex([], [], now);

  // Upsert the line
  if (type === 'adjudication') {
    indexBody = upsertAdjudicationLine(indexBody, entry);
  } else {
    indexBody = upsertLessonLine(indexBody, entry);
  }

  // Bump generated_at in the _Last rebuilt_ line
  indexBody = indexBody.replace(
    /_Last rebuilt: \d{4}-\d{2}-\d{2}/,
    `_Last rebuilt: ${now.slice(0, 10)}`
  );

  atomicWrite(indexPath, indexBody);

  // Update manifest
  const manifest = loadManifest(manifestPath) || {version: 1, generated_at: now, files: {}};
  manifest.generated_at = now;
  manifest.files[entry.relPath] = {
    hash: entry.hash,
    type: entry.type,
    ref: entry.ref,
    title: entry.title,
    ...(entry.status ? {status: entry.status} : {}),
    ...(entry.rule ? {rule: entry.rule} : {}),
  };
  atomicWrite(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  // Upsert entry into keyword map (load existing, upsert by ref, write)
  await upsertKeywordMapEntry(entry, keywordMapPath, now);

  stdout.write(`Appended ${type} ${entry.ref} → ${indexPath}\n`);
}

// Upsert a single entry into the keyword map atomically
async function upsertKeywordMapEntry(entry, keywordMapPath, now) {
  try {
    const tokenize = await getTokenize();
    const seedText = (entry.title || '') + ' ' + (entry.slug || '') + ' ' + (entry.ref || '');
    const tokens = [...new Set(tokenize(seedText))];
    const triggers = extractTriggers(entry.content || '');
    const newMapEntry = {
      ref: entry.ref,
      type: entry.type,
      title: entry.title || '',
      relPath: entry.relPath || '',
      rule: entry.rule || '',
      status: entry.status || '',
      tokens,
      triggers,
    };

    let map = {version: 1, generated_at: now, entries: []};
    if (existsSync(keywordMapPath)) {
      try { map = JSON.parse(readFileSync(keywordMapPath, 'utf8')); } catch {}
    }
    map.generated_at = now;
    // Upsert by ref
    const idx = (map.entries || []).findIndex(e => e.ref === entry.ref);
    if (idx >= 0) {
      map.entries[idx] = newMapEntry;
    } else {
      map.entries = [...(map.entries || []), newMapEntry];
    }
    atomicWrite(keywordMapPath, JSON.stringify(map, null, 2) + '\n');
  } catch {
    // Fail-open
  }
}

// ─────────────────────────────────────────────── delta ──────────────────────

async function cmdDelta(root, emitJson) {
  // CRITICAL: entire body in try/catch — must exit 0 on any error.
  // Core compute+write is delegated to the shared tools/lib/knowledge-delta.mjs
  // module so the hook can call applyDelta() in-process without spawning a
  // subprocess (satisfies the SessionStart zero-spawnSync invariant).
  try {
    const lib = await getDeltaLib();
    // applyDelta: computes delta, self-heals index+manifest+kwmap if needed.
    // Also check whether manifest existed BEFORE to drive the noManifest cap.
    const {manifestPath} = getOutputPaths(root);
    const noManifest = !existsSync(manifestPath);

    const {added, changed, removed} = await lib.applyDelta(root);

    if (emitJson) {
      stdout.write(JSON.stringify({added, changed, removed}) + '\n');
    } else {
      // Human digest — cap to 8 most recent when manifest was missing and list is large
      const items = [...added, ...changed];
      const cap = noManifest ? 8 : items.length;
      const capped = items.slice(0, cap);
      if (capped.length > 0) {
        const prefix = 'Knowledge delta since last session:';
        for (const p of capped) {
          stdout.write(`${prefix} ${p}\n`);
        }
        if (items.length > cap) {
          stdout.write(`  (${items.length - cap} more — run rebuild for full index)\n`);
        }
      }
      if (removed.length > 0) {
        for (const p of removed) {
          stdout.write(`Knowledge removed: ${p}\n`);
        }
      }
    }
  } catch {
    // Fail-open: any error → emit empty result, exit 0
    if (emitJson) {
      stdout.write(JSON.stringify({added: [], changed: [], removed: []}) + '\n');
    }
  }
}

// ─────────────────────────────────────────────── dispatch ───────────────────

switch (cmd) {
  case 'rebuild':
    cmdRebuild(opts.root).catch(e => {
      stderr.write('error: ' + (e.stack || e.message || String(e)) + '\n');
      exit(1);
    });
    break;

  case 'append':
    cmdAppend(opts.root, named.type, named.file).catch(e => {
      stderr.write('error: ' + (e.stack || e.message || String(e)) + '\n');
      exit(1);
    });
    break;

  case 'delta':
    // Always exits 0 — delta is fail-open
    cmdDelta(opts.root, !!named.json).catch(() => {
      // Fail-open: if the async wrapper itself throws, exit 0
      if (named.json) stdout.write(JSON.stringify({added: [], changed: [], removed: []}) + '\n');
    });
    break;

  default:
    die(`unknown command: ${cmd}`);
}
