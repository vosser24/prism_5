#!/usr/bin/env node
// prism-validate-plugins — v3.11.0 Phase C. Audit installed Claude Code
// plugins for broken hooks, missing manifests, and skill-name conflicts.
//
// Locked design: docs/prism/adjudications/D004-v4-product-vision.md Phase C.
//
// Subcommands:
//   audit [--json]
//     Read `claude plugin list --json` (or PRISM_PLUGIN_LIST_FIXTURE in
//     tests), apply three checks, emit findings.
//
//     Default output: human-readable. --json: machine output.
//     Exit codes: 0 = clean, 1 = error-level findings, 2 = git guard,
//                 5 = bad flag, 7 = claude CLI not found, 8 = invalid JSON.
//
// --fix is NOT implemented in v3.11.0 per D004 risk register (false-positive
// risk on legitimate plugins); the audit is report-only until telemetry
// supports an auto-fix path. Slash command can offer manual fix prompts.
//
// All subcommands accept --root <path> and refuse without .git/ unless
// --no-git-guard is passed.

import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {isAbsolute, join, resolve} from 'node:path';
import {argv, exit, stderr, stdout} from 'node:process';
import {prismHome} from '../hooks/lib/prism-home.mjs';

// ------------------------------ args ------------------------------

const args = argv.slice(2);
const opts = {root: process.cwd(), json: false, noGitGuard: false};
const positional = [];

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--root') opts.root = resolve(args[++i]);
  else if (a === '--json') opts.json = true;
  else if (a === '--no-git-guard') opts.noGitGuard = true;
  else if (a === '-h' || a === '--help' || a === 'help') usage();
  else positional.push(a);
}

const cmd = positional.shift();
if (!cmd) usage(1);

function usage(code = 0) {
  stdout.write(`Usage: prism-validate-plugins <command> [args] [--root <path>] [--no-git-guard]

Commands:
  audit [--json]
`);
  exit(code);
}

// ------------------------------ guards ------------------------------

if (!opts.noGitGuard && !existsSync(join(opts.root, '.git'))) {
  die(`refusing to run: ${opts.root} has no .git/. Pass --no-git-guard to override.`, 2);
}

function die(msg, code = 1) {
  stderr.write(msg + '\n');
  exit(code);
}

// ------------------------------ plugin list source ------------------------------

// Reads either the fixture file (tests) or the real `claude plugin list --json`
// output. Returns the parsed object or throws on JSON parse failure.
function loadPluginList() {
  const fixture = process.env.PRISM_PLUGIN_LIST_FIXTURE;
  let raw;
  if (fixture) {
    if (!existsSync(fixture)) {
      die(`PRISM_PLUGIN_LIST_FIXTURE points to missing file: ${fixture}`, 8);
    }
    raw = readFileSync(fixture, 'utf-8');
  } else {
    const r = spawnSync('claude', ['plugin', 'list', '--json'], {encoding: 'utf-8', timeout: 15000});
    if (r.error && r.error.code === 'ENOENT') {
      die('claude CLI not found on PATH; install Claude Code or set PRISM_PLUGIN_LIST_FIXTURE for tests.', 7);
    }
    if (r.error && r.error.code === 'ETIMEDOUT') {
      die('claude plugin list timed out after 15s — corrupted plugin cache or network issue.', 7);
    }
    if (r.status !== 0) {
      die(`claude plugin list failed (exit ${r.status}): ${r.stderr || r.stdout}`, 7);
    }
    raw = r.stdout;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    die(`plugin list output is not valid JSON: ${e.message}`, 8);
  }
}

// ------------------------------ audit checks ------------------------------

// `claude plugin list --json` emits a TOP-LEVEL ARRAY of entries shaped:
//   {id, version, scope, enabled, installPath, installedAt, lastUpdated, mcpServers}
// It exposes NEITHER hooks NOR skills, so those two checks read the plugin's
// on-disk layout (.claude-plugin/plugin.json + hooks/hooks.json + skills/*/).
// We stay back-compatible with the older {plugins:[{name,path,hooks,skills}]}
// shape (and any future CLI that inlines hooks/skills) via field aliases and
// an "inline wins, else disk" discovery strategy.

function normalizePluginList(parsed) {
  if (Array.isArray(parsed)) return parsed;            // real CLI: top-level array
  if (parsed && Array.isArray(parsed.plugins)) return parsed.plugins;  // legacy / fixtures
  return [];
}

function pluginName(p) { return (p && (p.name || p.id)) || '(unknown)'; }
function pluginPath(p) { return (p && (p.installPath || p.path)) || null; }

function readJSONSafe(p) {
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}

// Expand ~/, ${VAR}, and %VAR%. `extra` overrides process.env (used to map
// ${CLAUDE_PLUGIN_ROOT} → installPath when checking a plugin's own hooks).
// Returns {path, unresolved}; unresolved=true means a referenced var was not
// found anywhere — callers MUST skip such paths to avoid false positives.
function expandPath(p, extra = {}) {
  let out = p;
  let unresolved = false;
  if (out.startsWith('~/')) {
    const home = prismHome();
    out = join(home, out.slice(2));
  }
  let safety = 0;
  while (safety < 16) {
    const m = out.match(/\$\{([A-Za-z_][A-Za-z_0-9]*)\}|%([A-Za-z_][A-Za-z_0-9]*)%/);
    if (!m) break;
    const key = m[1] || m[2];
    let value;
    if (Object.prototype.hasOwnProperty.call(extra, key)) value = extra[key];
    else if (process.env[key] != null) value = process.env[key];
    else { unresolved = true; value = ''; }
    out = out.replace(m[0], value);
    safety++;
  }
  return {path: out, unresolved};
}

function extractFilePathArg(command) {
  if (!command || typeof command !== 'string') return null;
  // Split on whitespace but respect quoted segments minimally.
  const tokens = command.match(/"[^"]+"|\S+/g) || [];
  // Scan right-to-left: the last token that looks like a file path is the candidate.
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i].replace(/^"|"$/g, '');
    if (/^(\/|~\/|\$\{[A-Za-z_][A-Za-z_0-9]*\}|%[A-Za-z_][A-Za-z_0-9]*%|[A-Za-z]:[\\/])/.test(t)) {
      return t;
    }
  }
  return null;
}

// A Claude Code hooks config is an event-map: { EventName: [ {matcher?, hooks:[{type,command}]} ] }.
// Extract every command string from it.
function collectHookCommandsFromConfig(cfg) {
  const out = [];
  if (!cfg || typeof cfg !== 'object') return out;
  for (const event of Object.keys(cfg)) {
    const matchers = cfg[event];
    if (!Array.isArray(matchers)) continue;
    for (const m of matchers) {
      const hs = Array.isArray(m && m.hooks) ? m.hooks : [];
      for (const h of hs) {
        if (h && typeof h.command === 'string') out.push(h.command);
      }
    }
  }
  return out;
}

// Hook commands for a plugin. Inline plugin.hooks (array of {command}) wins —
// used by tests and any future CLI that inlines them. Otherwise read the
// on-disk layout: .claude-plugin/plugin.json `.hooks` + conventional hooks/hooks.json.
function discoverHookCommands(plugin) {
  if (Array.isArray(plugin.hooks)) {
    return plugin.hooks.map(h => h && h.command).filter(c => typeof c === 'string');
  }
  const ip = pluginPath(plugin);
  if (!ip || !existsSync(ip)) return [];
  const cmds = [];
  const manifest = readJSONSafe(join(ip, '.claude-plugin', 'plugin.json')) || readJSONSafe(join(ip, 'plugin.json'));
  if (manifest && manifest.hooks != null) {
    if (typeof manifest.hooks === 'string') {
      const hp = isAbsolute(manifest.hooks) ? manifest.hooks : join(ip, manifest.hooks);
      const cfg = readJSONSafe(hp);
      cmds.push(...collectHookCommandsFromConfig(cfg && cfg.hooks ? cfg.hooks : cfg));
    } else {
      cmds.push(...collectHookCommandsFromConfig(manifest.hooks));
    }
  }
  const hooksJson = join(ip, 'hooks', 'hooks.json');
  if (existsSync(hooksJson)) {
    const cfg = readJSONSafe(hooksJson);
    cmds.push(...collectHookCommandsFromConfig(cfg && cfg.hooks ? cfg.hooks : cfg));
  }
  return cmds;
}

// Skill names a plugin provides. Inline plugin.skills (array of {name}) wins;
// otherwise enumerate the on-disk skills/*/ directories.
function discoverSkillNames(plugin) {
  if (Array.isArray(plugin.skills)) {
    return plugin.skills.map(s => s && s.name).filter(n => typeof n === 'string');
  }
  const ip = pluginPath(plugin);
  if (!ip) return [];
  const skillsDir = join(ip, 'skills');
  if (!existsSync(skillsDir)) return [];
  try {
    return readdirSync(skillsDir, {withFileTypes: true}).filter(d => d.isDirectory()).map(d => d.name);
  } catch { return []; }
}

// Inline shell programs (statement separators, command substitution, pipelines,
// or an explicit `sh -c`) have no single target file to validate — extracting a
// "path" from them yields glob fragments and false positives (e.g. claude-mem's
// `export PATH=…; ls …/[0-9]*/; exec node …`). We only validate simple
// "runner <script-file>" commands; anything script-like is skipped.
function isInlineShellScript(command) {
  if (/(^|\s)(sh|bash|zsh|dash)\s+(-[A-Za-z]*c\b|--command\b)/.test(command)) return true;
  return /;|\$\(|`|&&|\|\|/.test(command);
}

function checkBrokenHooks(plugin) {
  const findings = [];
  const ip = pluginPath(plugin);
  const extra = {};
  if (ip) { extra.CLAUDE_PLUGIN_ROOT = ip; extra.PLUGIN_ROOT = ip; }
  const home = prismHome();
  extra.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  for (const command of discoverHookCommands(plugin)) {
    if (isInlineShellScript(command)) continue;  // inline program, no single file to check
    const candidate = extractFilePathArg(command);
    if (!candidate) continue;  // raw shell command, nothing to validate
    if (/[*?[\]]/.test(candidate)) continue;  // glob pattern — can't existence-check, stay conservative
    const {path: expanded, unresolved} = expandPath(candidate, extra);
    if (unresolved) continue;  // referenced an unknown var — can't verify, stay conservative
    if (!existsSync(expanded)) {
      findings.push({
        level: 'error',
        type: 'broken_hook',
        plugin: pluginName(plugin),
        message: `hook command references missing file: ${candidate}`,
        path: expanded,
      });
    }
  }
  return findings;
}

function checkMissingManifest(plugin) {
  const ip = pluginPath(plugin);
  if (!ip || typeof ip !== 'string') return [];
  if (existsSync(ip)) return [];
  return [{
    level: 'error',
    type: 'missing_manifest',
    plugin: pluginName(plugin),
    message: `plugin path does not exist: ${ip}`,
    path: ip,
  }];
}

function checkSkillConflicts(plugins) {
  const skillOwners = new Map();  // skill name → [plugin names]
  for (const p of plugins) {
    for (const name of discoverSkillNames(p)) {
      if (!skillOwners.has(name)) skillOwners.set(name, []);
      skillOwners.get(name).push(pluginName(p));
    }
  }
  const findings = [];
  for (const [skillName, owners] of skillOwners) {
    if (owners.length > 1) {
      findings.push({
        level: 'warn',
        type: 'skill_conflict',
        plugin: null,
        message: `skill "${skillName}" provided by multiple plugins: ${owners.join(', ')} `
          + `(Claude Code namespaces plugin skills as plugin:skill, so this is informational)`,
        owners,
      });
    }
  }
  return findings;
}

function auditPlugins(pluginList) {
  const plugins = normalizePluginList(pluginList);
  const findings = [];
  for (const p of plugins) {
    findings.push(...checkBrokenHooks(p));
    findings.push(...checkMissingManifest(p));
  }
  findings.push(...checkSkillConflicts(plugins));
  return {plugins_audited: plugins.length, findings};
}

// ------------------------------ output ------------------------------

function emitHuman(result) {
  stdout.write(`Audited ${result.plugins_audited} plugin(s).\n`);
  if (!result.findings.length) {
    stdout.write('No findings — plugin installation looks clean.\n');
    return;
  }
  const byLevel = {error: [], warn: [], info: []};
  for (const f of result.findings) (byLevel[f.level] || byLevel.info).push(f);
  for (const level of ['error', 'warn', 'info']) {
    for (const f of byLevel[level] || []) {
      const tag = level.toUpperCase().padEnd(5);
      const plugin = f.plugin ? `[${f.plugin}] ` : '';
      stdout.write(`  ${tag} ${plugin}${f.type}: ${f.message}\n`);
    }
  }
}

// ------------------------------ command dispatch ------------------------------

try {
  switch (cmd) {
    case 'audit': {
      const list = loadPluginList();
      const result = auditPlugins(list);
      if (opts.json) {
        stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else {
        emitHuman(result);
      }
      const hasError = result.findings.some(f => f.level === 'error');
      exit(hasError ? 1 : 0);
      break;
    }
    default:
      die(`unknown command: ${cmd}`);
  }
} catch (e) {
  stderr.write('error: ' + (e.stack || e.message || String(e)) + '\n');
  exit(1);
}
