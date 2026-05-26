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
import {existsSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {argv, exit, stderr, stdout} from 'node:process';

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

// Hook commands look like:
//   "bash ~/.claude/hooks/lib/prism-exec.sh ~/.claude/hooks/X.mjs"
//   "cmd /c \"%USERPROFILE%\\.claude\\hooks\\lib\\prism-exec.cmd\" \"%USERPROFILE%\\...\""
//   "echo done"  ← raw shell, no file to check
//
// We extract the LAST whitespace-separated token that looks like a path
// (starts with /, ~/, drive-letter, or %VAR%) and check whether it exists
// on disk after env expansion. Anything else is treated as a non-file hook
// and skipped.
function expandHomeAndEnv(p) {
  let out = p;
  if (out.startsWith('~/')) {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    out = join(home, out.slice(2));
  }
  // %VAR% (Windows). Expand the first occurrence; loop only a few times.
  let safety = 0;
  while (safety < 8) {
    const m = out.match(/%([A-Za-z_][A-Za-z_0-9]*)%/);
    if (!m) break;
    const value = process.env[m[1]] || '';
    out = out.replace(m[0], value);
    safety++;
  }
  return out;
}

function extractFilePathArg(command) {
  if (!command || typeof command !== 'string') return null;
  // Split on whitespace but respect quoted segments minimally.
  const tokens = command.match(/"[^"]+"|\S+/g) || [];
  // Scan right-to-left: the last token that looks like a file path is the candidate.
  for (let i = tokens.length - 1; i >= 0; i--) {
    let t = tokens[i].replace(/^"|"$/g, '');
    if (/^(\/|~\/|%[A-Za-z_][A-Za-z_0-9]*%|[A-Za-z]:[\\/])/.test(t)) {
      return t;
    }
  }
  return null;
}

function checkBrokenHooks(plugin) {
  const findings = [];
  const hooks = Array.isArray(plugin.hooks) ? plugin.hooks : [];
  for (const h of hooks) {
    const candidate = extractFilePathArg(h.command);
    if (!candidate) continue;  // raw shell command, nothing to validate
    const expanded = expandHomeAndEnv(candidate);
    if (!existsSync(expanded)) {
      findings.push({
        level: 'error',
        type: 'broken_hook',
        plugin: plugin.name,
        message: `hook command references missing file: ${candidate}`,
        path: expanded,
      });
    }
  }
  return findings;
}

function checkMissingManifest(plugin) {
  if (!plugin.path || typeof plugin.path !== 'string') return [];
  if (existsSync(plugin.path)) return [];
  return [{
    level: 'error',
    type: 'missing_manifest',
    plugin: plugin.name,
    message: `plugin path does not exist: ${plugin.path}`,
    path: plugin.path,
  }];
}

function checkSkillConflicts(plugins) {
  const skillOwners = new Map();  // skill name → [plugin names]
  for (const p of plugins) {
    const skills = Array.isArray(p.skills) ? p.skills : [];
    for (const s of skills) {
      if (!s || typeof s.name !== 'string') continue;
      if (!skillOwners.has(s.name)) skillOwners.set(s.name, []);
      skillOwners.get(s.name).push(p.name);
    }
  }
  const findings = [];
  for (const [skillName, owners] of skillOwners) {
    if (owners.length > 1) {
      findings.push({
        level: 'warn',
        type: 'skill_conflict',
        plugin: null,
        message: `skill "${skillName}" registered by multiple plugins: ${owners.join(', ')}`,
        owners,
      });
    }
  }
  return findings;
}

function auditPlugins(pluginList) {
  const plugins = Array.isArray(pluginList?.plugins) ? pluginList.plugins : [];
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
