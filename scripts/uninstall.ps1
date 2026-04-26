# PRISM one-command uninstaller (PowerShell port of uninstall.sh)
# Removes PRISM-owned files from ~/.claude/ and surgically edits
# ~/.claude/settings.json to drop PRISM hook entries / statusLine / env.
#
# Compatible with Windows PowerShell 5.1+ and PowerShell 7+.
# Idempotent: re-running with -Purge is a safe no-op.
#
# DEFAULT MODE IS DRY-RUN — pass -Purge to actually mutate the system.
# This is INVERTED vs install.ps1 because uninstall is destructive.

[CmdletBinding()]
param(
    [switch]$Purge,
    [switch]$KeepMemory,
    [switch]$NoBackup,
    [string]$Reinstall,
    [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# --- defaults --------------------------------------------------------------
$IsDryRun     = -not $Purge
$CurrentStep  = 'startup'
$ClaudeDir    = Join-Path $env:USERPROFILE '.claude'

# Per-category counters
$Script:CntHooks    = 0
$Script:CntCommands = 0
$Script:CntSkills   = 0
$Script:CntAgents   = 0
$Script:CntTools    = 0
$Script:CntMisc     = 0
$Script:CntState    = 0
$Script:CntMemory   = 0

# Preserved-paths accumulator
$Script:Preserved = New-Object System.Collections.Generic.List[string]

# 8 PRISM-owned skills (by exact name; never glob)
$PrismSkills = @(
    'prism-plan',
    'prism-discover',
    'prism-chat',
    'blueprint-prompt',
    'workflow-orchestration',
    'claude-code-expert',
    'notebooklm',
    'video-production'
)

# 3 PRISM-owned core agents
$PrismAgents = @(
    'master-orchestrator.md',
    'agent-factory.md',
    'prism-updater.md'
)

# --- helpers ---------------------------------------------------------------
function Write-UninstallLog {
    param([Parameter(Mandatory=$true)][string]$Message)
    Write-Host "[uninstall] $Message"
}

function Write-UninstallErr {
    param([Parameter(Mandatory=$true)][string]$Message)
    Write-Host "[uninstall] ERROR: $Message" -ForegroundColor Red
}

function Show-Usage {
    $usage = @'
PRISM uninstaller — removes PRISM from ~/.claude/

Usage: .\uninstall.ps1 [-Purge] [-KeepMemory] [-NoBackup] [-Reinstall [path]] [-Help]

! DESTRUCTIVE: -Purge is REQUIRED to actually delete.

Parameters:
  (no flag)         DRY-RUN — print what would be deleted, mutate nothing.
                    Default for safety. Inverted vs install.ps1.
  -Purge            Required to actually delete PRISM artifacts.
  -KeepMemory       Preserve .prism-sessions/ and .prism-rollups/ (session memory + rollups).
  -NoBackup         Skip pre-uninstall backup of ~/.claude/ (NOT recommended).
  -Reinstall [path] Chain uninstall -> install in one run from [path].
  -Help             Print this usage.

Examples:
  .\uninstall.ps1                                 # Preview only (safe)
  .\uninstall.ps1 -Purge                          # Actually uninstall (creates backup first)
  .\uninstall.ps1 -Purge -KeepMemory              # Uninstall but keep session memory
  .\uninstall.ps1 -Purge -Reinstall C:\path\to\PRISM   # Uninstall + immediately reinstall

Steps performed:
  1   Pre-flight: confirm ~/.claude/ exists
  2   Backup ~/.claude/ -> ~/.claude/backups/pre-uninstall-[ts]/
  3   Inventory: count files per category
  4   Remove PRISM hooks
  5   Remove PRISM commands
  6   Remove 8 PRISM-owned skills (by exact name)
  7   Remove 3 PRISM core agents (by exact name)
  8   Remove PRISM tools
  9   Remove misc files (statusline-command.sh, prism.env, plans)
  10  Remove ~/.claude/.prism-* state files
  11  Remove user memory (unless -KeepMemory)
  12  Surgically edit ~/.claude/settings.json
  13  Final report
  14  If -Reinstall, exec the installer

Re-running with -Purge is a safe no-op (every step is idempotent).
'@
    Write-Host $usage
}

# Test path existence (handles files, dirs, and symlinks).
function Test-PathExists {
    param([Parameter(Mandatory=$true)][string]$Path)
    return (Test-Path -LiteralPath $Path)
}

# Delete a single path if it exists; in dry-run print "would delete".
# $CounterName is a Script-scope variable name (string).
function Remove-PrismPath {
    param(
        [Parameter(Mandatory=$true)][string]$CounterName,
        [Parameter(Mandatory=$true)][string]$Target
    )
    if (Test-PathExists -Path $Target) {
        if ($IsDryRun) {
            Write-UninstallLog "  would delete: $Target"
        } else {
            Remove-Item -LiteralPath $Target -Recurse -Force -ErrorAction SilentlyContinue
        }
        $current = Get-Variable -Name $CounterName -Scope Script -ValueOnly
        Set-Variable -Name $CounterName -Scope Script -Value ($current + 1)
    }
}

# Delete every match of a wildcard pattern (sh-style glob).
# Uses Get-ChildItem with -Path to expand the wildcard safely.
function Remove-PrismGlob {
    param(
        [Parameter(Mandatory=$true)][string]$CounterName,
        [Parameter(Mandatory=$true)][string]$Pattern
    )
    $items = @(Get-ChildItem -Path $Pattern -Force -ErrorAction SilentlyContinue)
    foreach ($item in $items) {
        Remove-PrismPath -CounterName $CounterName -Target $item.FullName
    }
}

function Add-PreservedPath {
    param([Parameter(Mandatory=$true)][string]$Path)
    $Script:Preserved.Add($Path) | Out-Null
}

# Count matches of a wildcard pattern (used for inventory).
function Get-GlobCount {
    param([Parameter(Mandatory=$true)][string]$Pattern)
    return @(Get-ChildItem -Path $Pattern -Force -ErrorAction SilentlyContinue).Count
}

# --- help short-circuit ----------------------------------------------------
if ($Help) {
    Show-Usage
    exit 0
}

# --- banner ----------------------------------------------------------------
Write-UninstallLog "PRISM uninstaller starting"
if ($IsDryRun) {
    Write-UninstallLog "  mode=DRY-RUN (no changes will be made; pass -Purge to mutate)"
} else {
    Write-UninstallLog "  mode=PURGE (will actually delete files)"
}
Write-UninstallLog "  keep-memory=$([int][bool]$KeepMemory)"
Write-UninstallLog "  no-backup=$([int][bool]$NoBackup)"
if ($Reinstall) {
    Write-UninstallLog "  reinstall-repo=$Reinstall"
}

try {
    # =====================================================================
    # Step 1 — Pre-flight
    # =====================================================================
    $CurrentStep = '1/preflight'
    Write-UninstallLog "step 1: pre-flight"

    if (-not (Test-PathExists -Path $ClaudeDir)) {
        Write-UninstallLog "PRISM doesn't appear to be installed at ~/.claude — nothing to do."
        exit 0
    }
    Write-UninstallLog "  ok: $ClaudeDir present"

    # =====================================================================
    # Step 2 — Backup
    # =====================================================================
    $CurrentStep = '2/backup'
    $TS = Get-Date -Format 'yyyyMMdd_HHmmss'
    $BackupDir = Join-Path $ClaudeDir "backups\pre-uninstall-$TS"

    if ($NoBackup) {
        Write-UninstallLog "step 2: SKIPPED (-NoBackup) — not recommended"
        $BackupDir = '(skipped)'
    } else {
        Write-UninstallLog "step 2: backing up ~/.claude/ to $BackupDir"
        if ($IsDryRun) {
            Write-UninstallLog "  DRY-RUN: would: copy [each ~/.claude/* except backups/] to $BackupDir/"
        } else {
            New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
            $entries = Get-ChildItem -LiteralPath $ClaudeDir -Force -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -ne 'backups' }
            foreach ($entry in $entries) {
                try {
                    Copy-Item -LiteralPath $entry.FullName -Destination $BackupDir -Recurse -Force -ErrorAction SilentlyContinue
                } catch {
                    # best-effort backup; continue on per-entry errors
                }
            }
        }
    }

    # =====================================================================
    # Step 3 — Inventory pass
    # =====================================================================
    $CurrentStep = '3/inventory'
    Write-UninstallLog "step 3: inventory (counts of PRISM-owned files in $ClaudeDir)"

    $invHooks = (Get-GlobCount -Pattern (Join-Path $ClaudeDir 'hooks\prism-*.mjs')) `
              + (Get-GlobCount -Pattern (Join-Path $ClaudeDir 'hooks\lib\prism-*.mjs')) `
              + (Get-GlobCount -Pattern (Join-Path $ClaudeDir 'hooks\lib\prism-exec.sh')) `
              + (Get-GlobCount -Pattern (Join-Path $ClaudeDir 'hooks\lib\prism-exec.cmd'))

    $invCommands = Get-GlobCount -Pattern (Join-Path $ClaudeDir 'commands\prism-*.md')

    $invSkills = 0
    foreach ($s in $PrismSkills) {
        $skillDir = Join-Path $ClaudeDir "skills\$s"
        $skillMd  = Join-Path $ClaudeDir "skills\$s.md"
        if ((Test-PathExists -Path $skillDir) -or (Test-PathExists -Path $skillMd)) {
            $invSkills++
        }
    }

    $invAgents = 0
    foreach ($a in $PrismAgents) {
        $agentPath = Join-Path $ClaudeDir "agents\$a"
        if (Test-PathExists -Path $agentPath) {
            $invAgents++
        }
    }

    $invTools = (Get-GlobCount -Pattern (Join-Path $ClaudeDir 'tools\prism-*')) `
              + (Get-GlobCount -Pattern (Join-Path $ClaudeDir 'tools\lib\prism-*.mjs'))
    if (Test-PathExists -Path (Join-Path $ClaudeDir 'tools\subagent-summary.py')) { $invTools++ }
    if (Test-PathExists -Path (Join-Path $ClaudeDir 'tools\prism-monitor'))       { $invTools++ }

    $invMisc = 0
    if (Test-PathExists -Path (Join-Path $ClaudeDir 'statusline-command.sh')) { $invMisc++ }
    if (Test-PathExists -Path (Join-Path $ClaudeDir 'prism.env'))             { $invMisc++ }
    $invMisc += (Get-GlobCount -Pattern (Join-Path $ClaudeDir 'plans\prism-*.md'))

    $invState = Get-GlobCount -Pattern (Join-Path $ClaudeDir '.prism-*')

    $invMemory = 0
    if (Test-PathExists -Path (Join-Path $ClaudeDir '.prism-sessions')) { $invMemory++ }
    if (Test-PathExists -Path (Join-Path $ClaudeDir '.prism-rollups'))  { $invMemory++ }

    Write-UninstallLog "  hooks            : $invHooks"
    Write-UninstallLog "  commands         : $invCommands"
    Write-UninstallLog "  skills (of 8)    : $invSkills"
    Write-UninstallLog "  agents (of 3)    : $invAgents"
    Write-UninstallLog "  tools            : $invTools"
    Write-UninstallLog "  misc             : $invMisc"
    Write-UninstallLog "  state dot-files  : $invState"
    Write-UninstallLog "  memory entries   : $invMemory"

    $invTotal = $invHooks + $invCommands + $invSkills + $invAgents + $invTools + $invMisc + $invState + $invMemory
    Write-UninstallLog "  --- inventory total: $invTotal ---"
    if ($invTotal -eq 0) {
        Write-UninstallLog "  nothing PRISM-owned found — uninstall is a no-op"
    }

    # =====================================================================
    # Step 4 — Hooks
    # =====================================================================
    $CurrentStep = '4/hooks'
    Write-UninstallLog "step 4: removing PRISM hooks"
    Remove-PrismGlob -CounterName 'CntHooks' -Pattern (Join-Path $ClaudeDir 'hooks\prism-*.mjs')
    Remove-PrismGlob -CounterName 'CntHooks' -Pattern (Join-Path $ClaudeDir 'hooks\lib\prism-*.mjs')
    Remove-PrismGlob -CounterName 'CntHooks' -Pattern (Join-Path $ClaudeDir 'hooks\lib\prism-exec.sh')
    Remove-PrismGlob -CounterName 'CntHooks' -Pattern (Join-Path $ClaudeDir 'hooks\lib\prism-exec.cmd')

    # =====================================================================
    # Step 5 — Commands
    # =====================================================================
    $CurrentStep = '5/commands'
    Write-UninstallLog "step 5: removing PRISM commands"
    Remove-PrismGlob -CounterName 'CntCommands' -Pattern (Join-Path $ClaudeDir 'commands\prism-*.md')

    # =====================================================================
    # Step 6 — Skills (8 by exact name)
    # =====================================================================
    $CurrentStep = '6/skills'
    Write-UninstallLog "step 6: removing PRISM-owned skills (by exact name)"
    foreach ($s in $PrismSkills) {
        Remove-PrismPath -CounterName 'CntSkills' -Target (Join-Path $ClaudeDir "skills\$s")
        Remove-PrismPath -CounterName 'CntSkills' -Target (Join-Path $ClaudeDir "skills\$s.md")
    }

    # =====================================================================
    # Step 7 — Core agents (3 by exact name)
    # =====================================================================
    $CurrentStep = '7/agents'
    Write-UninstallLog "step 7: removing PRISM core agents (by exact name)"
    foreach ($a in $PrismAgents) {
        Remove-PrismPath -CounterName 'CntAgents' -Target (Join-Path $ClaudeDir "agents\$a")
    }

    # =====================================================================
    # Step 8 — Tools
    # =====================================================================
    $CurrentStep = '8/tools'
    Write-UninstallLog "step 8: removing PRISM tools"
    Remove-PrismGlob -CounterName 'CntTools' -Pattern (Join-Path $ClaudeDir 'tools\prism-*')
    Remove-PrismGlob -CounterName 'CntTools' -Pattern (Join-Path $ClaudeDir 'tools\lib\prism-*.mjs')
    Remove-PrismPath -CounterName 'CntTools' -Target (Join-Path $ClaudeDir 'tools\subagent-summary.py')
    Remove-PrismPath -CounterName 'CntTools' -Target (Join-Path $ClaudeDir 'tools\prism-monitor')

    # =====================================================================
    # Step 9 — Misc
    # =====================================================================
    $CurrentStep = '9/misc'
    Write-UninstallLog "step 9: removing misc PRISM files"
    Remove-PrismPath -CounterName 'CntMisc' -Target (Join-Path $ClaudeDir 'statusline-command.sh')
    Remove-PrismPath -CounterName 'CntMisc' -Target (Join-Path $ClaudeDir 'prism.env')
    Remove-PrismGlob -CounterName 'CntMisc' -Pattern (Join-Path $ClaudeDir 'plans\prism-*.md')

    # =====================================================================
    # Step 10 — State dot-files
    # =====================================================================
    $CurrentStep = '10/state'
    Write-UninstallLog "step 10: removing ~/.claude/.prism-* state files"
    $stateItems = @(Get-ChildItem -Path (Join-Path $ClaudeDir '.prism-*') -Force -ErrorAction SilentlyContinue)
    foreach ($p in $stateItems) {
        $base = $p.Name
        if ($base -eq '.prism-sessions' -or $base -eq '.prism-rollups') {
            if ($KeepMemory) {
                Write-UninstallLog "  preserving (-KeepMemory): $($p.FullName)"
                Add-PreservedPath -Path $p.FullName
            }
            # In either case, memory dirs are handled in step 11 (or preserved).
            continue
        }
        Remove-PrismPath -CounterName 'CntState' -Target $p.FullName
    }

    # =====================================================================
    # Step 11 — User memory
    # =====================================================================
    $CurrentStep = '11/memory'
    if ($KeepMemory) {
        Write-UninstallLog "step 11: SKIPPED (-KeepMemory)"
        Write-UninstallLog "PRESERVED: .prism-sessions/ + .prism-rollups/ (--keep-memory)"
        $sessPath = Join-Path $ClaudeDir '.prism-sessions'
        $rollPath = Join-Path $ClaudeDir '.prism-rollups'
        if (Test-PathExists -Path $sessPath) { Add-PreservedPath -Path $sessPath }
        if (Test-PathExists -Path $rollPath) { Add-PreservedPath -Path $rollPath }
    } else {
        Write-UninstallLog "step 11: removing user memory"
        Remove-PrismPath -CounterName 'CntMemory' -Target (Join-Path $ClaudeDir '.prism-sessions')
        Remove-PrismPath -CounterName 'CntMemory' -Target (Join-Path $ClaudeDir '.prism-rollups')
    }

    # =====================================================================
    # Step 12 — Surgically edit settings.json
    # =====================================================================
    $CurrentStep = '12/settings-edit'
    $SettingsPath = Join-Path $ClaudeDir 'settings.json'
    Write-UninstallLog "step 12: surgically editing $SettingsPath"

    if (-not (Test-PathExists -Path $SettingsPath)) {
        Write-UninstallLog "  no settings.json found — skipping"
    } else {
        if ($IsDryRun) {
            Write-UninstallLog "  DRY-RUN: would: edit ~/.claude/settings.json to remove PRISM hook entries"
        } else {
            $nodeAvailable = $null
            try { $nodeAvailable = Get-Command node -ErrorAction SilentlyContinue } catch { $nodeAvailable = $null }

            if (-not $nodeAvailable) {
                Write-UninstallLog "  WARN: 'node' not found on PATH — cannot surgically edit settings.json"
                Write-UninstallLog "  please remove PRISM hook entries from $SettingsPath manually"
            } else {
                $nodeScript = @'
const fs = require('fs');
const file = process.env.PRISM_SETTINGS;
let raw;
try { raw = fs.readFileSync(file, 'utf8'); }
catch (e) { console.error(`[uninstall]   ERROR reading ${file}: ${e.message}`); process.exit(1); }

let cfg;
try { cfg = JSON.parse(raw); }
catch (e) { console.error(`[uninstall]   ERROR parsing ${file}: ${e.message}`); process.exit(1); }

const PRISM_CMD_RX = /(prism-exec\.(sh|cmd))|(prism-[a-z0-9-]+\.mjs)/i;

let removedHookEntries = 0;
let removedHookGroups = 0;

if (cfg.hooks && typeof cfg.hooks === 'object') {
    for (const eventName of Object.keys(cfg.hooks)) {
        const groups = cfg.hooks[eventName];
        if (!Array.isArray(groups)) continue;
        const newGroups = [];
        for (const group of groups) {
            if (!group || !Array.isArray(group.hooks)) {
                newGroups.push(group);
                continue;
            }
            const filteredHooks = group.hooks.filter(h => {
                if (!h || typeof h.command !== 'string') return true;
                if (PRISM_CMD_RX.test(h.command)) {
                    removedHookEntries++;
                    return false;
                }
                return true;
            });
            if (filteredHooks.length === 0) {
                removedHookGroups++;
                continue;
            }
            group.hooks = filteredHooks;
            newGroups.push(group);
        }
        if (newGroups.length === 0) {
            delete cfg.hooks[eventName];
        } else {
            cfg.hooks[eventName] = newGroups;
        }
    }
    if (Object.keys(cfg.hooks).length === 0) {
        delete cfg.hooks;
    }
}

let removedStatusLine = false;
if (cfg.statusLine) {
    const sl = cfg.statusLine;
    const cmd = (sl && typeof sl === 'object' && typeof sl.command === 'string') ? sl.command : '';
    if (cmd && /(statusline-command\.sh|prism\.env|prism-)/i.test(cmd)) {
        delete cfg.statusLine;
        removedStatusLine = true;
    }
}

let removedEnvKey = false;
if (cfg.env && typeof cfg.env === 'object') {
    const keys = Object.keys(cfg.env);
    if (keys.length === 1 && keys[0] === 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS') {
        delete cfg.env;
        removedEnvKey = true;
    }
}

const summary = `[uninstall]   settings.json: removed ${removedHookEntries} hook entries, ${removedHookGroups} empty groups, statusLine=${removedStatusLine}, env-key=${removedEnvKey}`;
console.log(summary);

const out = JSON.stringify(cfg, null, 2) + '\n';
fs.writeFileSync(file, out);
console.log(`[uninstall]   wrote ${file}`);
'@
                $env:PRISM_SETTINGS = $SettingsPath
                try {
                    $nodeScript | & node -
                } finally {
                    Remove-Item Env:\PRISM_SETTINGS -ErrorAction SilentlyContinue
                }
            }
        }
    }

    # =====================================================================
    # Step 13 — Final report
    # =====================================================================
    $CurrentStep = '13/report'
    Write-UninstallLog "----- UNINSTALL REPORT -----"
    if ($IsDryRun) {
        Write-UninstallLog "  MODE: DRY-RUN — nothing was deleted"
        Write-UninstallLog "  re-run with -Purge to actually remove the files above"
    } else {
        Write-UninstallLog "  MODE: PURGE — files removed"
    }
    Write-UninstallLog "  hooks      removed: $($Script:CntHooks)"
    Write-UninstallLog "  commands   removed: $($Script:CntCommands)"
    Write-UninstallLog "  skills     removed: $($Script:CntSkills)"
    Write-UninstallLog "  agents     removed: $($Script:CntAgents)"
    Write-UninstallLog "  tools      removed: $($Script:CntTools)"
    Write-UninstallLog "  misc       removed: $($Script:CntMisc)"
    Write-UninstallLog "  state      removed: $($Script:CntState)"
    Write-UninstallLog "  memory     removed: $($Script:CntMemory)"
    Write-UninstallLog "  backup at: $BackupDir"

    if ($Script:Preserved.Count -gt 0) {
        Write-UninstallLog "  preserved paths:"
        foreach ($line in $Script:Preserved) {
            Write-UninstallLog "    $line"
        }
    } else {
        Write-UninstallLog "  preserved paths: (none)"
    }

    # =====================================================================
    # Step 14 — Optional reinstall
    # =====================================================================
    $CurrentStep = '14/reinstall'
    if ($Reinstall) {
        $installScript = Join-Path $Reinstall 'scripts\install.ps1'
        Write-UninstallLog "step 14: chaining reinstall via $installScript -NoBackup"
        if (-not (Test-PathExists -Path $installScript)) {
            Write-UninstallErr "install.ps1 not found at $installScript"
            exit 1
        }
        if ($IsDryRun) {
            Write-UninstallLog "  DRY-RUN: would exec: $installScript -NoBackup"
        } else {
            & $installScript -NoBackup
            exit $LASTEXITCODE
        }
    }

    exit 0
}
catch {
    Write-Host "[uninstall] ERROR at step ${CurrentStep}: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
