#!/usr/bin/env node
// PRISM Mutation Guard (v5.4.0)
//
// PreToolUse hook on **Bash only** (v5.4.0+). When the parent (Opus) context
// runs a Bash/PowerShell command that WRITES a file, this guard emits a PRISM
// NOTICE and optionally blocks the call — because PowerShell's default writers
// introduce UTF-8 BOM corruption on Windows and Bash-writes bypass the
// orchestrator pattern.
//
// v5.4.0 re-scope (D010 §6): the guard NO LONGER blocks the clean Edit/Write/
// MultiEdit tools in the parent. Those tools emit clean UTF-8 and are the
// recommended path; the parent-dispatch-guard already owns tier-based
// work-gating for them. Hard-blocking them was the single biggest source of
// everyday friction and duplicated the dispatch-guard. The matcher is narrowed
// to "Bash" in settings.fragment.json + plugin.json; MUTATION_TOOLS is empty so
// a stale-matcher install degrades to ALLOW on Edit/Write rather than blocking.
// NOTE: the Bash write-pattern list is positive-match / non-exhaustive by
// design — it is a BOM-hazard nudge for common cases, NOT a complete write
// fence. The permission allowlist is the real fence.
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
// Bootstrap allowlist (v2.2.1): `/prism-update` and `/prism-archive` are
// legitimate write contexts — these commands MUST write new project files
// by design. If the user's current prompt is one of these slash commands,
// the guard passes through.
//
// Logs to ~/.claude/.prism-routing.jsonl.

import {readFileSync, appendFileSync, mkdirSync, existsSync} from 'fs';
import {join, dirname, basename} from 'path';
import {createHash} from 'crypto';
import {prismHome} from './lib/prism-home.mjs';

const H = prismHome();
const LOG_PATH = join(H, '.claude', '.prism-routing.jsonl');
const MODE = (process.env.PRISM_MUTATION_GUARD !== undefined
  ? process.env.PRISM_MUTATION_GUARD
  : 'hard').toLowerCase();
const IS_WINDOWS = process.platform === 'win32';

// v5.4.0 (D010 §6): mutation-guard is now Bash/PowerShell-write-only. The clean
// Edit/Write/MultiEdit tools emit clean UTF-8 and are the recommended path; the
// parent-dispatch-guard owns tier-based work-gating for them (its positive-list
// matcher includes Edit|Write|MultiEdit and they are absent from its
// ALWAYS_ALLOW). This set is intentionally EMPTY so a stale-matcher install
// (one still wired to `Edit|Write|MultiEdit|Bash` before the upgrade re-merges)
// degrades to ALLOW on those tools instead of hard-blocking edits.
const MUTATION_TOOLS = new Set();

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

  // echo / printf / cat redirect to a file  (POSIX + PowerShell)
  // - `[^|&;<>]*?` so the lazy run can't swallow a `>` and re-anchor on a later
  //   one (which let `2>>err.log` slip through).
  // - `(?<![0-9&])` rejects fd redirects: `2>`, `2>>`, `&>` are stderr/dup, not
  //   a stdout-to-file write. This is what fixes the `cat <file> 2>/dev/null`
  //   false-positive that blocked read-only state inspection.
  // - `(?!&|/dev/null\b)` rejects `>&fd` and the `/dev/null` sink.
  /\b(echo|printf|cat)\b[^|&;<>]*?(?<![0-9&])>>?\s*(?!&|\/dev\/null\b)["']?[^|&;<>\s"']+/,

  // Here-doc to file — `cmd <<EOF > file` form.
  // Uses [ \t] (horizontal-only) instead of \s so a `>` in a subsequent body
  // line (e.g. `->` arrows in a git commit message) can't satisfy the match.
  // \w+ allows lowercase and underscore delimiters (<<eof, <<END_OF_MSG, …).
  // Excludes >&fd and /dev/null sink like the sibling patterns do.
  /<<[ \t-]*['"]?\w+['"]?[ \t]*>>?[ \t]*(?!&|\/dev\/null\b)["']?[^\s|&;<>]+/,

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
const BOOTSTRAP_COMMANDS = ['/prism-update', '/prism-archive'];

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
export function classifyBashCommand(cmd) {
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

// v5.7: dual-mode. Exported run(input) returns {exit, stdout, stderr} so the
// consolidated PreToolUse dispatcher can execute this guard in-process (one node
// spawn for all Bash guards). The standalone shim at the bottom preserves the
// original wire behavior (stdin → stdout → exit) for direct invocation + the
// golden-master harness. Behavior is byte-identical; only the I/O boundary moved.
export function run(input) {
  let out = '';
  const write = (s) => { out += s; };
  const done = (code) => ({exit: code, stdout: out, stderr: ''});

  const toolName = input.tool_name || '';

  // v5.4.0 (D010 §6): Bash/PowerShell-write-only. Any non-Bash tool — including
  // Edit/Write/MultiEdit on a stale-matcher install still firing this hook —
  // exits cleanly here (degrades to ALLOW, never blocks edits). MUTATION_TOOLS
  // is empty by design; this is the belt-and-suspenders for that contract.
  if (toolName !== 'Bash' || MUTATION_TOOLS.has(toolName)) return done(0);
  if (MODE === 'off') return done(0);

  const ti = input.tool_input || {};
  const filePath = getFilePath(ti);

  // Only proceed if the Bash command is a file-write. Non-write Bash
  // (git status, ls, node --version, etc.) passes cleanly.
  const bashClass = classifyBashCommand(ti.command || ti.cmd || '');
  if (!bashClass.isWrite) return done(0);

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
    return done(0);
  }

  // Subagent detection — three bypass paths (parity with parent-dispatch-guard
  // since v2.7.5). Any one of them means the caller is a subagent and the
  // mutation tool call should pass.
  //
  //   1. input.parent_tool_use_id present — the original v2.2.1 check.
  //   2. CLAUDE_CODE_ENTRYPOINT env var === 'subagent' — some Claude Code
  //      runtimes set this instead of (or in addition to) parent_tool_use_id.
  //   3. sentinel.dispatched === true — the parent already dispatched an
  //      Agent() this turn, so subsequent tool calls (parent OR child whose
  //      parent_tool_use_id was lost) all pass. This matches the v2.2.1
  //      "dispatch-guard path 3" reasoning and covers Claude Code builds
  //      where parent_tool_use_id isn't propagated to subagent tool calls.
  //
  // Observed in the wild (2.7.4 → 2.7.5 root cause): some Claude Code
  // builds send Agent() calls whose subagent tool-use payloads have NEITHER
  // parent_tool_use_id NOR CLAUDE_CODE_ENTRYPOINT. Without path 3, subagent
  // Edit/Write/Bash get denied as if they were parent-context calls. The
  // dispatch-guard has always had all three paths. The mutation-guard was
  // stuck on only path 1 — this parity fix closes the gap.
  const isSubagentById = !!(input.parent_tool_use_id);
  const isSubagentByEnv = String(process.env.CLAUDE_CODE_ENTRYPOINT || '').toLowerCase() === 'subagent';
  // Read sentinel now — this is BEFORE the force_opus check below (which will
  // re-read via the same helper, cheap because the sentinel file is small).
  // `sentinelEarly` intentionally scoped local to avoid TDZ with the force_opus
  // block's `sentinel` declaration later in main().
  const sentinelEarly = readSentinel(input.session_id);
  const isSubagentByDispatched = !!(sentinelEarly && sentinelEarly.dispatched === true);

  if (isSubagentById || isSubagentByEnv || isSubagentByDispatched) {
    appendLog({
      ts: new Date().toISOString(),
      event: 'mutation_guard',
      mode: MODE,
      tool: toolName,
      file: filePath,
      blocked: false,
      reason: isSubagentById
        ? 'subagent-parent-tool-use-id-passthrough'
        : (isSubagentByEnv
            ? 'subagent-claude-code-entrypoint-passthrough'
            : 'subagent-sentinel-dispatched-passthrough'),
      bash_write: true,
    });
    return done(0);
  }

  // FIX-A (v5.x): the conversation-model tier-override file must stay writable
  // even when the guard would otherwise block parent mutations — it is the
  // documented in-session escape from a false-positive panel/dispatch block
  // (v5.0 stress-test finding). Without this the override is unreachable.
  if (/[/\\]\.prism-turn-tier-[^/\\]*\.json$/.test(String(filePath || ''))) {
    return done(0);
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
    return done(0);
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
    return done(0);
  }

  // Parent context + Bash/PowerShell file-write.
  const noticeParts = [
    `PRISM MUTATION-GUARD: Bash/PowerShell file-write detected in parent (Opus) context.`,
    `Pattern: ${bashClass.matchedPattern}`,
    `This was blocked because parent-context writes via Bash/PowerShell (a) bypass the orchestrator pattern and (b) on Windows introduce UTF-8 BOM corruption with the default PowerShell writers.`,
    `Fixes (pick one):`,
    `  1. Use the Edit/Write/MultiEdit tool directly — they emit clean UTF-8 and are NOT blocked in the parent (v5.4.0).`,
    `  2. Dispatch to a subagent: Agent({subagent_type:'general-purpose', model:'sonnet', prompt:'<spec for the edit>'}).`,
    `  3. Override for this turn: prefix your user prompt with !opus-force:.`,
    `  4. Disable the guard for the whole session: set PRISM_MUTATION_GUARD=off in settings.local.json env.`,
  ];
  if (IS_WINDOWS && !bashClass.bomSafe) {
    noticeParts.push(bomWarning());
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
    reason: blocked ? 'parent-bash-write-blocked' : 'parent-bash-write-nudge',
    file_hash: sha256short(filePath),
    bash_pattern: bashClass.matchedPattern,
    bom_safe: IS_WINDOWS ? !!bashClass.bomSafe : undefined,
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
    write(JSON.stringify(deny));
    return done(2);
  }

  write(notice);
  return done(0);
}

// Guard: only run as a hook when invoked directly, NOT when imported by tests.
const invokedDirectly = process.argv[1] && basename(process.argv[1]) === 'prism-mutation-guard.mjs';
if (invokedDirectly) {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf-8')); } catch { process.exit(0); }
  const r = run(input);
  if (r.stdout) process.stdout.write(r.stdout);
  process.exit(r.exit || 0);
}
