#!/usr/bin/env node
// PRISM Mutation Guard (v2.7.2)
//
// PreToolUse hook on Edit, Write, MultiEdit, AND Bash (v2.7.2+). When the
// parent (Opus) context calls a mutation tool directly — instead of
// dispatching the edit to a subagent — this guard emits a PRISM NOTICE and
// optionally blocks the call.
//
// v2.7.2 extensions:
//   - Matcher expanded to include `Bash`. When Bash is called from parent
//     context AND the command contains file-write patterns (PowerShell
//     Set-Content/Out-File, shell `>` redirect, sed -i, etc.), the guard
//     applies the same block as Edit/Write. This stops the compensation
//     pattern where a blocked parent routes writes through PowerShell —
//     which introduces UTF-8 BOM corruption on Windows.
//   - Windows BOM warning: when the Bash command matches a write pattern
//     AND platform is win32, the deny/nudge message explicitly calls out
//     the PowerShell UTF-8-with-BOM default and prescribes the fix
//     (`-Encoding UTF8NoBOM` or prefer Edit/Write tools).
//   - Bash pass-through for non-write commands is preserved — the guard
//     only inspects Bash when the command looks like a file mutation.
//
// The orchestrator pattern: Opus plans + evaluates; subagents execute.
// Direct Edit/Write/file-writing-Bash in the parent context breaks that
// boundary.
//
// Detection: the PreToolUse payload carries `parent_tool_use_id` when the
// call originates inside a subagent. If that field is absent (or empty/null),
// the caller is the parent context.
//
// Modes (PRISM_MUTATION_GUARD env var):
//   hard (default, unset):  emit NOTICE + exit 2 (tool blocked)
//   soft:                   emit NOTICE + exit 0 (pass-through with nudge)
//   off:                    silent pass-through, exit 0
//
// Override: if the user prompt contains "!opus-force:", pass through silently.
//
// Bootstrap allowlist (v2.2.1): `/prism-init`, `/prism-update`, and
// `/prism-archive` are legitimate write contexts — these commands MUST
// write new project files by design. If the user's current prompt is one
// of these slash commands, the guard passes through.
//
// Logs to ~/.claude/.prism-routing.jsonl.

import {readFileSync, appendFileSync, mkdirSync, existsSync} from 'fs';
import {join, dirname} from 'path';
import {createHash} from 'crypto';

const H = process.env.HOME || process.env.USERPROFILE;
const LOG_PATH = join(H, '.claude', '.prism-routing.jsonl');
const MODE = (process.env.PRISM_MUTATION_GUARD !== undefined
  ? process.env.PRISM_MUTATION_GUARD
  : 'hard').toLowerCase();
const IS_WINDOWS = process.platform === 'win32';

const MUTATION_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

// v2.7.2: Bash commands that write files. When the command matches ANY
// of these patterns and the caller is parent context (ROUTINE/NOVEL tier),
// we apply the same mutation-guard block. This closes the "parent gets
// blocked on Edit, compensates via PowerShell Set-Content, introduces BOM"
// loophole that caused the v2.7.1 migration pain.
//
// Non-exhaustive by design — we want false negatives (let some edge cases
// through) over false positives (blocking non-write Bash like `git status`
// or `ls`). Focus on common, unambiguous write patterns.
const BASH_WRITE_PATTERNS = [
  // PowerShell explicit writers
  /\b(Set-Content|Add-Content|Out-File|Export-Csv|Export-Clixml)\b/i,
  /\bTee-Object\b[^|&;]*?-FilePath\b/i,
  /\b\[System\.IO\.File\]::(WriteAllText|WriteAllLines|WriteAllBytes|AppendAllText)\b/i,
  /\bConvertTo-(Json|Yaml|Xml|Csv)\b[^|]*\|\s*(Set-Content|Out-File)\b/i,

  // POSIX / PowerShell redirect to a file-looking argument
  // Extension whitelist keeps this from matching `... > /dev/null` or `... > &2`
  /\s>>?\s+["']?[^|&;<>\s"']*\.(md|json|jsonc|yaml|yml|toml|ts|tsx|js|jsx|mjs|cjs|py|sh|cmd|ps1|env|txt|xml|css|scss|sass|less|html|htm|sql|rs|go|java|kt|swift|rb|php|c|cc|cpp|h|hpp|csv|tsv|ini|conf|cfg)\b/,

  // echo / printf / cat heredoc to file  (POSIX + PowerShell)
  /\b(echo|printf|cat)\b[^|&;]*?>\s*["']?[^|&;<>\s"']+/,

  // Here-doc to file
  /<<[-\s]*['"]?[A-Z]+['"]?[^|&;]*?>\s*[^\s]+/,

  // In-place edits / writers
  /\bsed\s+-[a-zA-Z]*i\b/,
  /\bawk\b[^|&;]*?>\s*[^\s|&;]+/,
  /\bperl\s+-[a-zA-Z]*i\b/,

  // Python / Node / Ruby file-write one-liners
  /\bpython[23]?\s+-c\b.*?\bopen\s*\([^)]*?[,\s]\s*['"]w/s,
  /\bnode\s+-e\b.*?\b(writeFileSync|createWriteStream|appendFileSync)\b/s,
  /\bruby\s+-e\b.*?\bFile\.(write|open)\b/s,

  // curl / wget download-to-file (could be malicious; at minimum it mutates)
  /\bcurl\b[^|&;]*?-[a-zA-Z]*o[a-zA-Z]*\s+["']?[^|&;<>\s"']*\.(json|md|ts|js|mjs|cjs|py|sh|cmd|ps1|env|txt|xml|css|html|sql)\b/,
  /\bwget\b[^|&;]*?-[a-zA-Z]*O[a-zA-Z]*\s+["']?[^|&;<>\s"']*\.(json|md|ts|js|mjs|cjs|py|sh|cmd|ps1|env|txt|xml|css|html|sql)\b/,

  // cp / mv into project paths (not /tmp, /dev, ~/.cache, etc.)
  // These are real file mutations the orchestrator should know about.
  /\b(cp|mv|move|copy)\b[^|&;]*?(\b|\\)(src|app|lib|components|hooks|agents|commands|skills|tests|docs|\.claude)\b/,

  // git restore / checkout that overwrites files
  /\bgit\s+(restore|checkout)\b[^|&;]*?(--|[^-]\s*)[a-zA-Z_\-./\\]+\.(md|json|ts|tsx|js|jsx|mjs|py|sh|ps1)\b/,
];

// PowerShell-specific write patterns that are safe from BOM IF the user
// provides -Encoding UTF8NoBOM. If this is present in the command AND the
// write pattern matches, downgrade the "BOM warning" to "acknowledged".
const BOM_SAFE_RE = /-Encoding\s+(UTF8NoBOM|ASCII|Utf8NoBOM)\b|UTF8Encoding\]::new\s*\(\s*\$false\s*\)/i;

// Bootstrap/write commands — these legitimately need to write project files.
const BOOTSTRAP_COMMANDS = ['/prism-init', '/prism-update', '/prism-archive'];

function sentinelPath(sessionId) {
  return join(H, '.claude', `.prism-turn-tier-${sessionId || 'anon'}.json`);
}

function readSentinel(sessionId) {
  try {
    const p = sentinelPath(sessionId);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch { return null; }
}

function isBootstrapTurn(input) {
  const s = readSentinel(input.session_id);
  if (s && typeof s.rationale === 'string') {
    for (const cmd of BOOTSTRAP_COMMANDS) {
      if (s.rationale.includes(cmd)) return cmd;
    }
  }
  const p = String(input.user_prompt || input.prompt || '').trim().toLowerCase();
  for (const cmd of BOOTSTRAP_COMMANDS) {
    if (p.startsWith(cmd)) return cmd;
  }
  return null;
}

function sha256short(text) {
  return createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
}

function appendLog(obj) {
  try {
    mkdirSync(dirname(LOG_PATH), {recursive: true});
    appendFileSync(LOG_PATH, JSON.stringify(obj) + '\n');
  } catch {}
}

function getFilePath(toolInput) {
  if (!toolInput) return '<unknown>';
  return toolInput.file_path || toolInput.path || '<unknown>';
}

// Check whether a Bash command string looks like a file-writing command.
// Returns { isWrite, bomSafe, matchedPattern } — bomSafe only meaningful
// when isWrite=true AND platform=win32.
function classifyBashCommand(cmd) {
  if (!cmd) return { isWrite: false };
  const s = String(cmd);
  for (const re of BASH_WRITE_PATTERNS) {
    if (re.test(s)) {
      return {
        isWrite: true,
        matchedPattern: re.source.slice(0, 60),
        bomSafe: BOM_SAFE_RE.test(s),
      };
    }
  }
  return { isWrite: false };
}

function bomWarning() {
  return [
    '',
    'WINDOWS BOM WARNING: PowerShell `Set-Content`, `Out-File`, and `>` redirection',
    'default to UTF-8 **with BOM** (EF BB BF prefix). Git diff will show a stray',
    'character at file start; many parsers (YAML, JSON schemas, some linters) choke.',
    'Safe alternatives:',
    '  • Use PRISM\'s Write/Edit tool directly (no BOM).',
    '  • Or append `-Encoding UTF8NoBOM` to Set-Content/Out-File.',
    '  • Or: [System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))',
  ].join('\n');
}

function main() {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf-8')); }
  catch { process.exit(0); }

  const toolName = input.tool_name || '';
  const isBash = toolName === 'Bash';
  const isMutationTool = MUTATION_TOOLS.has(toolName);

  if (!isMutationTool && !isBash) process.exit(0);
  if (MODE === 'off') process.exit(0);

  const ti = input.tool_input || {};
  const filePath = getFilePath(ti);

  // v2.7.2: when Bash is the tool, only proceed if the command is a write.
  // Non-write Bash (git status, ls, node --version, etc.) passes cleanly.
  let bashClass = null;
  if (isBash) {
    const cmd = ti.command || ti.cmd || '';
    bashClass = classifyBashCommand(cmd);
    if (!bashClass.isWrite) process.exit(0);
  }

  // Bootstrap command auto-bypass.
  const bootstrapCmd = isBootstrapTurn(input);
  if (bootstrapCmd) {
    appendLog({
      ts: new Date().toISOString(),
      event: 'mutation_guard',
      mode: MODE,
      tool: toolName,
      file: filePath,
      blocked: false,
      reason: 'bootstrap-command-passthrough',
      command: bootstrapCmd,
    });
    process.exit(0);
  }

  // Subagent detection.
  const isSubagent = !!(input.parent_tool_use_id);
  if (isSubagent) {
    appendLog({
      ts: new Date().toISOString(),
      event: 'mutation_guard',
      mode: MODE,
      tool: toolName,
      file: filePath,
      blocked: false,
      reason: 'subagent-caller-passthrough',
      bash_write: isBash && bashClass?.isWrite ? true : undefined,
    });
    process.exit(0);
  }

  // User override via !opus-force: prefix.
  //
  // v2.7.4 fix: the prefix is detected on UserPromptSubmit (the tier-router
  // sets sentinel.force_opus=true). PreToolUse payloads do NOT reliably
  // carry user_prompt, so the old `input.user_prompt.includes('!opus-force:')`
  // check was effectively dead — the prefix correctly gated tier routing but
  // never reached this guard. v2.7.4 reads the sentinel as authoritative,
  // matching what parent-dispatch-guard.mjs does (and has done since v2.5.0).
  const sentinel = readSentinel(input.session_id);
  if (sentinel && sentinel.force_opus === true) {
    appendLog({
      ts: new Date().toISOString(),
      event: 'mutation_guard',
      mode: MODE,
      tool: toolName,
      file: filePath,
      blocked: false,
      reason: 'opus-force-sentinel',
      file_hash: sha256short(filePath),
    });
    process.exit(0);
  }
  // Legacy path: some Claude Code versions may still include user_prompt on
  // PreToolUse. Keep this as defense-in-depth so the prefix works even in
  // environments where the sentinel write somehow raced this hook.
  const userPrompt = input.user_prompt || input.prompt || '';
  if (String(userPrompt).includes('!opus-force:')) {
    appendLog({
      ts: new Date().toISOString(),
      event: 'mutation_guard',
      mode: MODE,
      tool: toolName,
      file: filePath,
      blocked: false,
      reason: 'opus-force-prompt',
      file_hash: sha256short(filePath),
    });
    process.exit(0);
  }

  // Parent context + mutation tool OR parent context + Bash-write.
  const noticeParts = [];
  if (isBash) {
    noticeParts.push(
      `PRISM MUTATION-GUARD: Bash file-write detected in parent (Opus) context.`,
      `Pattern: ${bashClass.matchedPattern}`,
      `This was blocked because parent-context writes via Bash/PowerShell (a) bypass the orchestrator pattern and (b) on Windows introduce UTF-8 BOM corruption with the default PowerShell writers.`,
      `Fixes (pick one):`,
      `  1. Dispatch to a subagent: Agent({subagent_type:'general-purpose', model:'sonnet', prompt:'<spec for the edit>'}). Subagents can use Edit/Write directly.`,
      `  2. Use the Edit/Write/MultiEdit tool in parent — the guard allows those when explicitly intended (they get the same nudge, but at least no BOM).`,
      `  3. Override for this turn: prefix your user prompt with !opus-force:.`,
      `  4. Disable the guard for the whole session: set PRISM_MUTATION_GUARD=off in settings.local.json env.`,
    );
    if (IS_WINDOWS && !bashClass.bomSafe) {
      noticeParts.push(bomWarning());
    }
  } else {
    noticeParts.push(
      `PRISM MUTATION-GUARD: ${toolName} called directly in the parent (Opus) context.`,
      `Dispatch via Agent({subagent_type:'general-purpose', model:'sonnet', prompt:'<paste your intended edit as a spec>'}).`,
      `Set PRISM_MUTATION_GUARD=off to disable, or prefix the user prompt with !opus-force: to override.`,
      `Tool: ${toolName}  File: ${filePath}`,
    );
  }
  const notice = noticeParts.join('\n');

  const blocked = (MODE === 'hard');

  appendLog({
    ts: new Date().toISOString(),
    event: 'mutation_guard',
    mode: MODE,
    tool: toolName,
    file: filePath,
    blocked,
    reason: blocked
      ? (isBash ? 'parent-bash-write-blocked' : 'parent-context-blocked')
      : (isBash ? 'parent-bash-write-nudge' : 'parent-context-nudge'),
    file_hash: sha256short(filePath),
    bash_pattern: isBash ? bashClass.matchedPattern : undefined,
    bom_safe: isBash && IS_WINDOWS ? !!bashClass.bomSafe : undefined,
    platform: process.platform,
  });

  if (blocked) {
    const deny = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: notice,
      },
    };
    process.stdout.write(JSON.stringify(deny));
    process.exit(2);
  }

  process.stdout.write(notice);
  process.exit(0);
}

main();
