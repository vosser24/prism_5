#requires -Version 5.1
# PRISM uninstaller (v3.8.4) -- defensive rewrite.
# Removes PRISM-owned files from ~/.claude/ and surgically edits
# ~/.claude/settings.json to drop PRISM hook entries / statusLine / env.
#
# Compatible with Windows PowerShell 5.1 plus and PowerShell 7 plus.
# Idempotent: re-running with -Purge is a safe no-op.
#
# DEFAULT MODE IS DRY-RUN -- pass -Purge to actually mutate the system.

param(
    [switch]$Purge,
    [switch]$KeepMemory,
    [switch]$NoBackup,
    [string]$ReinstallPath = '',
    [switch]$Help
)

# Intentionally NO Set-StrictMode and NO $ErrorActionPreference = 'Stop'.
# Those caused cascade-error confusion in earlier revisions on Windows PS 5.1.

# --- Top-level here-string for settings.json surgery ---------------------
# Single-quoted here-string (no PS interpolation). JS uses double quotes
# inside. The closing '@ MUST be at column 0.
$NodeSettingsScript = @'
const fs = require("fs");
const file = process.env.PRISM_SETTINGS;
if (!file) { console.error("[uninstall]   ERROR: PRISM_SETTINGS env var not set"); process.exit(1); }
if (!fs.existsSync(file)) { process.exit(0); }

let raw;
try { raw = fs.readFileSync(file, "utf8"); }
catch (e) { console.error("[uninstall]   ERROR reading " + file + ": " + e.message); process.exit(1); }

let cfg;
try { cfg = JSON.parse(raw); }
catch (e) { console.error("[uninstall]   ERROR parsing " + file + ": " + e.message); process.exit(1); }

const PRISM_CMD_RX = /(prism-exec\.(sh|cmd))|(prism-[a-z0-9-]+\.mjs)/i;

let removedHookEntries = 0;
let removedHookGroups = 0;

if (cfg.hooks && typeof cfg.hooks === "object") {
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
                if (!h || typeof h.command !== "string") return true;
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
    const cmd = (sl && typeof sl === "object" && typeof sl.command === "string") ? sl.command : "";
    if (cmd && /(statusline-command\.sh|prism\.env|prism-)/i.test(cmd)) {
        delete cfg.statusLine;
        removedStatusLine = true;
    }
}

let removedEnvKey = false;
if (cfg.env && typeof cfg.env === "object") {
    const keys = Object.keys(cfg.env);
    if (keys.length === 1 && keys[0] === "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS") {
        delete cfg.env;
        removedEnvKey = true;
    }
}

console.log("[uninstall]   settings.json: removed " + removedHookEntries + " hook entries, " + removedHookGroups + " empty groups, statusLine=" + removedStatusLine + ", env-key=" + removedEnvKey);
const out = JSON.stringify(cfg, null, 2) + "\n";
fs.writeFileSync(file, out);
console.log("[uninstall]   wrote " + file);
'@

# --- Help short-circuit --------------------------------------------------
if ($Help) {
    Write-Host 'PRISM uninstaller'
    Write-Host ''
    Write-Host 'Usage:'
    Write-Host '  .\uninstall.ps1                   DRY-RUN preview (default; safe)'
    Write-Host '  .\uninstall.ps1 -Purge            Actually delete'
    Write-Host '  .\uninstall.ps1 -KeepMemory       Preserve session memory dirs'
    Write-Host '  .\uninstall.ps1 -NoBackup         Skip pre-uninstall backup'
    Write-Host '  .\uninstall.ps1 -ReinstallPath C:\path\to\PRISM   Chain reinstall after'
    Write-Host '  .\uninstall.ps1 -Help             This message'
    Write-Host ''
    Write-Host 'Steps:'
    Write-Host '  1   Pre-flight: confirm ~/.claude/ exists'
    Write-Host '  2   Backup ~/.claude/ to ~/.claude/backups/pre-uninstall-[ts]/'
    Write-Host '  3   Inventory: count files per category'
    Write-Host '  4   Remove PRISM hooks'
    Write-Host '  5   Remove PRISM commands'
    Write-Host '  6   Remove 8 PRISM-owned skills (by exact name)'
    Write-Host '  7   Remove 3 PRISM core agents (by exact name)'
    Write-Host '  8   Remove PRISM tools'
    Write-Host '  9   Remove misc files (statusline-command.sh, prism.env, plans)'
    Write-Host '  10  Remove ~/.claude/.prism-* state files'
    Write-Host '  11  Remove user memory (unless -KeepMemory)'
    Write-Host '  12  Surgically edit ~/.claude/settings.json'
    Write-Host '  13  Final report'
    Write-Host '  14  If -ReinstallPath given, exec the installer'
    exit 0
}

# --- Setup ---------------------------------------------------------------
$IsDryRun  = -not $Purge
$ClaudeDir = Join-Path $env:USERPROFILE '.claude'

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

# 3 PRISM-owned core agents (by exact filename)
$PrismAgents = @(
    'master-orchestrator.md',
    'agent-factory.md',
    'prism-updater.md'
)

# Per-category counters
$CntHooks    = 0
$CntCommands = 0
$CntSkills   = 0
$CntAgents   = 0
$CntTools    = 0
$CntMisc     = 0
$CntState    = 0
$CntMemory   = 0
$Preserved   = New-Object System.Collections.Generic.List[string]

# Paths (relative to ~/.claude) whose user-mutated state must be preserved
# across the prism-plan skill-dir deletion in step 6. These files live INSIDE
# the skill dir so the bulk delete would otherwise wipe them.
#   - roster.json       : agent registrations, notebooklm_notebook_id, task counts, escalation history
#   - update-log.json   : version history
$PreservePaths = @(
    'skills\prism-plan\references\roster.json',
    'skills\prism-plan\references\update-log.json'
)
$PreservedRestored = New-Object System.Collections.Generic.List[string]

# --- Helpers (defined BEFORE main flow) ----------------------------------
function Log-Line {
    param([string]$Message)
    Write-Host ('[uninstall] ' + $Message)
}

function Log-Err {
    param([string]$Message)
    Write-Host ('[uninstall] ERROR: ' + $Message) -ForegroundColor Red
}

function Remove-IfExists {
    param(
        [string]$Path,
        [switch]$Recurse
    )
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    if ($IsDryRun) {
        Log-Line ('  would delete: ' + $Path)
        return $true
    }
    if ($Recurse) {
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
    } else {
        Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    }
    return $true
}

function Get-GlobCount {
    param([string]$Pattern)
    return @(Get-ChildItem -Path $Pattern -Force -ErrorAction SilentlyContinue).Count
}

# --- Banner --------------------------------------------------------------
Log-Line 'PRISM uninstaller starting'
if ($IsDryRun) {
    Log-Line '  mode=DRY-RUN (no changes will be made; pass -Purge to mutate)'
} else {
    Log-Line '  mode=PURGE (will actually delete files)'
}
Log-Line ('  keep-memory=' + [int][bool]$KeepMemory)
Log-Line ('  no-backup=' + [int][bool]$NoBackup)
if ($ReinstallPath -ne '') {
    Log-Line ('  reinstall-repo=' + $ReinstallPath)
}

# --- Step 1: Pre-flight --------------------------------------------------
Log-Line 'step 1: pre-flight'
if (-not (Test-Path -LiteralPath $ClaudeDir)) {
    Log-Line 'PRISM does not appear to be installed at ~/.claude -- nothing to do.'
    exit 0
}
Log-Line ('  ok: ' + $ClaudeDir + ' present')

# --- Step 2: Backup ------------------------------------------------------
$TS = Get-Date -Format 'yyyyMMdd_HHmmss'
$BackupDir = Join-Path $ClaudeDir ('backups\pre-uninstall-' + $TS)

if ($NoBackup) {
    Log-Line 'step 2: SKIPPED (-NoBackup) -- not recommended'
    $BackupDir = '(skipped)'
} else {
    Log-Line ('step 2: backing up ~/.claude/ to ' + $BackupDir)
    if ($IsDryRun) {
        Log-Line ('  DRY-RUN: would copy each ~/.claude/* (excluding backups) to ' + $BackupDir)
    } else {
        New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
        $entries = Get-ChildItem -LiteralPath $ClaudeDir -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'backups' }
        foreach ($entry in $entries) {
            Copy-Item -LiteralPath $entry.FullName -Destination $BackupDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

# --- Step 3: Inventory ---------------------------------------------------
Log-Line ('step 3: inventory (counts of PRISM-owned files in ' + $ClaudeDir + ')')

$invHooks = 0
$invHooks += Get-GlobCount -Pattern (Join-Path $ClaudeDir 'hooks\prism-*.mjs')
$invHooks += Get-GlobCount -Pattern (Join-Path $ClaudeDir 'hooks\lib\prism-*.mjs')
$invHooks += Get-GlobCount -Pattern (Join-Path $ClaudeDir 'hooks\lib\prism-exec.sh')
$invHooks += Get-GlobCount -Pattern (Join-Path $ClaudeDir 'hooks\lib\prism-exec.cmd')

$invCommands = Get-GlobCount -Pattern (Join-Path $ClaudeDir 'commands\prism-*.md')

$invSkills = 0
foreach ($s in $PrismSkills) {
    $skillDir = Join-Path $ClaudeDir ('skills\' + $s)
    $skillMd  = Join-Path $ClaudeDir ('skills\' + $s + '.md')
    if ((Test-Path -LiteralPath $skillDir) -or (Test-Path -LiteralPath $skillMd)) {
        $invSkills++
    }
}

$invAgents = 0
foreach ($a in $PrismAgents) {
    $agentPath = Join-Path $ClaudeDir ('agents\' + $a)
    if (Test-Path -LiteralPath $agentPath) {
        $invAgents++
    }
}

$invTools = 0
$invTools += Get-GlobCount -Pattern (Join-Path $ClaudeDir 'tools\prism-*')
$invTools += Get-GlobCount -Pattern (Join-Path $ClaudeDir 'tools\lib\prism-*.mjs')
if (Test-Path -LiteralPath (Join-Path $ClaudeDir 'tools\subagent-summary.py')) { $invTools++ }
if (Test-Path -LiteralPath (Join-Path $ClaudeDir 'tools\prism-monitor'))       { $invTools++ }

$invMisc = 0
if (Test-Path -LiteralPath (Join-Path $ClaudeDir 'statusline-command.sh')) { $invMisc++ }
if (Test-Path -LiteralPath (Join-Path $ClaudeDir 'prism.env'))             { $invMisc++ }
$invMisc += Get-GlobCount -Pattern (Join-Path $ClaudeDir 'plans\prism-*.md')

$invState = Get-GlobCount -Pattern (Join-Path $ClaudeDir '.prism-*')

$invMemory = 0
if (Test-Path -LiteralPath (Join-Path $ClaudeDir '.prism-sessions')) { $invMemory++ }
if (Test-Path -LiteralPath (Join-Path $ClaudeDir '.prism-rollups'))  { $invMemory++ }

Log-Line ('  hooks            : ' + $invHooks)
Log-Line ('  commands         : ' + $invCommands)
Log-Line ('  skills (of 8)    : ' + $invSkills)
Log-Line ('  agents (of 3)    : ' + $invAgents)
Log-Line ('  tools            : ' + $invTools)
Log-Line ('  misc             : ' + $invMisc)
Log-Line ('  state dot-files  : ' + $invState)
Log-Line ('  memory entries   : ' + $invMemory)

$invTotal = $invHooks + $invCommands + $invSkills + $invAgents + $invTools + $invMisc + $invState + $invMemory
Log-Line ('  --- inventory total: ' + $invTotal + ' ---')
if ($invTotal -eq 0) {
    Log-Line '  nothing PRISM-owned found -- uninstall is a no-op'
}

# --- Step 4: Hooks -------------------------------------------------------
Log-Line 'step 4: removing PRISM hooks'
$hookPatterns = @(
    (Join-Path $ClaudeDir 'hooks\prism-*.mjs'),
    (Join-Path $ClaudeDir 'hooks\lib\prism-*.mjs'),
    (Join-Path $ClaudeDir 'hooks\lib\prism-exec.sh'),
    (Join-Path $ClaudeDir 'hooks\lib\prism-exec.cmd')
)
foreach ($pat in $hookPatterns) {
    $items = @(Get-ChildItem -Path $pat -Force -ErrorAction SilentlyContinue)
    foreach ($item in $items) {
        if (Remove-IfExists -Path $item.FullName) { $CntHooks++ }
    }
}

# --- Step 5: Commands ----------------------------------------------------
Log-Line 'step 5: removing PRISM commands'
$cmdItems = @(Get-ChildItem -Path (Join-Path $ClaudeDir 'commands\prism-*.md') -Force -ErrorAction SilentlyContinue)
foreach ($item in $cmdItems) {
    if (Remove-IfExists -Path $item.FullName) { $CntCommands++ }
}

# --- Step 6 (pre): Preserve user-mutated data inside prism-plan ----------
# CRITICAL: roster.json + update-log.json live inside skills/prism-plan/
# and would be wiped by the recursive skill-dir delete below. Copy them
# to a temp preserve dir BEFORE deletion; restore AFTER all PRISM removal.
$PreserveTemp = Join-Path $env:TEMP ('prism-uninstall-preserve-' + $TS)
Log-Line 'step 6 (pre): preserving user-mutated data inside prism-plan'
$preservedCount = 0
foreach ($rel in $PreservePaths) {
    $abs = Join-Path $ClaudeDir $rel
    if (Test-Path -LiteralPath $abs) {
        if ($IsDryRun) {
            Log-Line ('  PRESERVE: would copy ' + $abs + ' -> ' + $PreserveTemp)
        } else {
            $tempPath = Join-Path $PreserveTemp $rel
            $tempDir  = Split-Path -Parent $tempPath
            New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
            Copy-Item -LiteralPath $abs -Destination $tempPath -Force -ErrorAction SilentlyContinue
            $preservedCount++
        }
    }
}
if ($preservedCount -gt 0) {
    Log-Line ('  preserved ' + $preservedCount + ' user-data file(s) to ' + $PreserveTemp)
}

# --- Step 6: Skills (8 by exact name) ------------------------------------
Log-Line 'step 6: removing PRISM-owned skills (by exact name)'
foreach ($s in $PrismSkills) {
    $skillDir = Join-Path $ClaudeDir ('skills\' + $s)
    $skillMd  = Join-Path $ClaudeDir ('skills\' + $s + '.md')
    if (Remove-IfExists -Path $skillDir -Recurse) { $CntSkills++ }
    if (Remove-IfExists -Path $skillMd) { $CntSkills++ }
}

# --- Step 7: Core agents (3 by exact name) -------------------------------
Log-Line 'step 7: removing PRISM core agents (by exact name)'
foreach ($a in $PrismAgents) {
    $agentPath = Join-Path $ClaudeDir ('agents\' + $a)
    if (Remove-IfExists -Path $agentPath) { $CntAgents++ }
}

# --- Step 8: Tools -------------------------------------------------------
Log-Line 'step 8: removing PRISM tools'
$toolPatterns = @(
    (Join-Path $ClaudeDir 'tools\prism-*'),
    (Join-Path $ClaudeDir 'tools\lib\prism-*.mjs')
)
foreach ($pat in $toolPatterns) {
    $items = @(Get-ChildItem -Path $pat -Force -ErrorAction SilentlyContinue)
    foreach ($item in $items) {
        if (Remove-IfExists -Path $item.FullName -Recurse) { $CntTools++ }
    }
}
if (Remove-IfExists -Path (Join-Path $ClaudeDir 'tools\subagent-summary.py')) { $CntTools++ }
if (Remove-IfExists -Path (Join-Path $ClaudeDir 'tools\prism-monitor') -Recurse) { $CntTools++ }

# --- Step 9: Misc --------------------------------------------------------
Log-Line 'step 9: removing misc PRISM files'
if (Remove-IfExists -Path (Join-Path $ClaudeDir 'statusline-command.sh')) { $CntMisc++ }
if (Remove-IfExists -Path (Join-Path $ClaudeDir 'prism.env')) { $CntMisc++ }
$planItems = @(Get-ChildItem -Path (Join-Path $ClaudeDir 'plans\prism-*.md') -Force -ErrorAction SilentlyContinue)
foreach ($item in $planItems) {
    if (Remove-IfExists -Path $item.FullName) { $CntMisc++ }
}

# --- Step 10: State dot-files --------------------------------------------
Log-Line 'step 10: removing ~/.claude/.prism-* state files'
$stateItems = @(Get-ChildItem -Path (Join-Path $ClaudeDir '.prism-*') -Force -ErrorAction SilentlyContinue)
foreach ($p in $stateItems) {
    $base = $p.Name
    if ($base -eq '.prism-sessions' -or $base -eq '.prism-rollups') {
        if ($KeepMemory) {
            Log-Line ('  preserving (-KeepMemory): ' + $p.FullName)
            $Preserved.Add($p.FullName) | Out-Null
        }
        # Memory dirs handled in step 11 (or preserved above).
        continue
    }
    if (Remove-IfExists -Path $p.FullName -Recurse) { $CntState++ }
}

# --- Step 11: User memory ------------------------------------------------
if ($KeepMemory) {
    Log-Line 'step 11: SKIPPED (-KeepMemory)'
    Log-Line 'PRESERVED: .prism-sessions/ and .prism-rollups/ (--keep-memory)'
    $sessPath = Join-Path $ClaudeDir '.prism-sessions'
    $rollPath = Join-Path $ClaudeDir '.prism-rollups'
    if (Test-Path -LiteralPath $sessPath) { $Preserved.Add($sessPath) | Out-Null }
    if (Test-Path -LiteralPath $rollPath) { $Preserved.Add($rollPath) | Out-Null }
} else {
    Log-Line 'step 11: removing user memory'
    if (Remove-IfExists -Path (Join-Path $ClaudeDir '.prism-sessions') -Recurse) { $CntMemory++ }
    if (Remove-IfExists -Path (Join-Path $ClaudeDir '.prism-rollups') -Recurse) { $CntMemory++ }
}

# --- Step 12: Surgical settings.json edit --------------------------------
$SettingsPath = Join-Path $ClaudeDir 'settings.json'
Log-Line ('step 12: surgically editing ' + $SettingsPath)

if (-not (Test-Path -LiteralPath $SettingsPath)) {
    Log-Line '  no settings.json found -- skipping'
} elseif ($IsDryRun) {
    Log-Line '  DRY-RUN: would edit ~/.claude/settings.json to remove PRISM hook entries'
} else {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCmd) {
        Log-Line '  WARN: node not found on PATH -- cannot surgically edit settings.json'
        Log-Line ('  please remove PRISM hook entries from ' + $SettingsPath + ' manually')
    } else {
        $env:PRISM_SETTINGS = $SettingsPath
        $NodeSettingsScript | & node -
        Remove-Item Env:\PRISM_SETTINGS -ErrorAction SilentlyContinue
    }
}

# --- Step 12 (post): Restore preserved user data ------------------------
# Move the temp-preserved roster.json + update-log.json back into the
# (just-deleted) skills/prism-plan/references/ directory, recreating
# the parent path as needed.
Log-Line 'step 12 (post): restoring preserved user data'
foreach ($rel in $PreservePaths) {
    $tempPath  = Join-Path $PreserveTemp $rel
    $finalPath = Join-Path $ClaudeDir $rel
    if ($IsDryRun) {
        $abs = Join-Path $ClaudeDir $rel
        if (Test-Path -LiteralPath $abs) {
            Log-Line ('  RESTORE: would restore ' + $finalPath)
            $PreservedRestored.Add($rel) | Out-Null
        }
    } else {
        if (Test-Path -LiteralPath $tempPath) {
            $finalDir = Split-Path -Parent $finalPath
            New-Item -ItemType Directory -Force -Path $finalDir | Out-Null
            Copy-Item -LiteralPath $tempPath -Destination $finalPath -Force -ErrorAction SilentlyContinue
            Log-Line ('  restored: ' + $finalPath)
            $PreservedRestored.Add($rel) | Out-Null
        }
    }
}
# Cleanup the preservation temp dir.
if (-not $IsDryRun -and (Test-Path -LiteralPath $PreserveTemp)) {
    Remove-Item -LiteralPath $PreserveTemp -Recurse -Force -ErrorAction SilentlyContinue
}

# --- Step 13: Final report -----------------------------------------------
Log-Line '----- UNINSTALL REPORT -----'
if ($IsDryRun) {
    Log-Line '  MODE: DRY-RUN -- nothing was deleted'
    Log-Line '  re-run with -Purge to actually remove the files above'
} else {
    Log-Line '  MODE: PURGE -- files removed'
}
Log-Line ('  hooks      removed: ' + $CntHooks)
Log-Line ('  commands   removed: ' + $CntCommands)
Log-Line ('  skills     removed: ' + $CntSkills)
Log-Line ('  agents     removed: ' + $CntAgents)
Log-Line ('  tools      removed: ' + $CntTools)
Log-Line ('  misc       removed: ' + $CntMisc)
Log-Line ('  state      removed: ' + $CntState)
Log-Line ('  memory     removed: ' + $CntMemory)
Log-Line ('  backup at: ' + $BackupDir)

if ($Preserved.Count -gt 0) {
    Log-Line '  preserved paths:'
    foreach ($line in $Preserved) {
        Log-Line ('    - ' + $line)
    }
} else {
    Log-Line '  preserved paths: (none)'
}

if ($PreservedRestored.Count -gt 0) {
    Log-Line '  preserved (user data):'
    foreach ($rel in $PreservedRestored) {
        Log-Line ('    - ' + ($rel -replace '\\','/'))
    }
} else {
    Log-Line '  preserved (user data): (none)'
}

# --- Step 14: Optional reinstall chain -----------------------------------
if ($ReinstallPath -ne '') {
    # Canonical installer (the legacy scripts\install.ps1 was retired in v5.1).
    $installScript = Join-Path $ReinstallPath 'tools\prism-installer.mjs'
    Log-Line ('step 14: chaining reinstall via node ' + $installScript + ' install')
    if (-not (Test-Path -LiteralPath $installScript)) {
        Log-Err ('prism-installer.mjs not found at ' + $installScript)
        exit 1
    }
    if ($IsDryRun) {
        Log-Line ('  DRY-RUN: would exec: node ' + $installScript + ' install')
    } else {
        & node $installScript install
        exit $LASTEXITCODE
    }
}

exit 0
