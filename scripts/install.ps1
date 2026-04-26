# PRISM PowerShell installer (v3.4.0)
#
# Native PowerShell port of scripts/install.sh — same step structure,
# same flag semantics, idiomatic PowerShell. Compatible with:
#   - PowerShell 5.1 (Windows default)
#   - PowerShell 7+ (cross-platform)
#
# Usage:
#   .\install.ps1                              # standard install
#   .\install.ps1 -DryRun                      # preview, no mutation
#   .\install.ps1 -Prefix C:\Tools\PRISM       # custom location
#   .\install.ps1 -Branch <name>               # specific branch
#   .\install.ps1 -NoBackup                    # skip pre-install backup
#   .\install.ps1 -Help                        # usage

[CmdletBinding()]
param(
    [string]$Prefix = (Join-Path $env:USERPROFILE 'PRISM'),
    [string]$Branch = 'main',
    [switch]$DryRun,
    [switch]$NoBackup,
    [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Script:CurrentStep = 'init'

function Write-InstallLog([string]$msg) {
    Write-Host "[install] $msg"
}

function Show-Help {
    @'
Usage: .\install.ps1 [-Prefix [dir]] [-Branch [name]] [-DryRun] [-NoBackup] [-Help]

Parameters:
  -Prefix [dir]     Clone destination (default: $env:USERPROFILE\PRISM)
  -Branch [name]    Branch to checkout (default: main)
  -DryRun           Print what would happen, mutate nothing
  -NoBackup         Skip pre-install backup of ~/.claude/ (NOT recommended)
  -Help             Print this usage

Examples:
  .\install.ps1                                            # Standard install
  .\install.ps1 -DryRun                                    # Preview only
  .\install.ps1 -Prefix C:\Tools\PRISM                     # Custom location
  .\install.ps1 -Branch claude/audit-pending-pushes-Rg1p8  # Specific branch
'@ | Write-Host
}

if ($Help) { Show-Help; exit 0 }

# =========================================================================
# Step 0 — Prereq check
# =========================================================================
function Test-Prereq {
    $Script:CurrentStep = '0/prereq'
    Write-InstallLog 'step 0: checking prerequisites'
    $missing = @()

    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) { Write-InstallLog "  ok: node $(& node --version)" } else { $missing += 'node' }

    $py = Get-Command python -ErrorAction SilentlyContinue
    if (-not $py) { $py = Get-Command python3 -ErrorAction SilentlyContinue }
    if ($py) { Write-InstallLog "  ok: python ($((& $py.Source --version) -replace '\s+',' '))" } else { $missing += 'python/python3' }

    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($git) { Write-InstallLog "  ok: $((& git --version))" } else { $missing += 'git' }

    if ($missing.Count -gt 0) {
        Write-Error "missing prerequisites: $($missing -join ', '). Install from https://nodejs.org / https://python.org / https://git-scm.com"
    }
}

# =========================================================================
# Step 1 — Clone or update
# =========================================================================
function Sync-Repo {
    $Script:CurrentStep = '1/clone'
    Write-InstallLog "step 1: clone or update repo at $Prefix"

    if (Test-Path (Join-Path $Prefix '.git')) {
        Write-InstallLog "  existing repo at $Prefix — updating to branch $Branch"
        if ($DryRun) {
            Write-InstallLog "  DRY-RUN: git -C `"$Prefix`" fetch ; git -C `"$Prefix`" checkout $Branch ; git -C `"$Prefix`" pull"
        } else {
            & git -C $Prefix fetch
            & git -C $Prefix checkout $Branch
            & git -C $Prefix pull
        }
    } else {
        Write-InstallLog "  cloning https://github.com/vosser24/PRISM to $Prefix (branch=$Branch)"
        if ($DryRun) {
            Write-InstallLog "  DRY-RUN: git clone --branch `"$Branch`" `"https://github.com/vosser24/PRISM`" `"$Prefix`""
        } else {
            & git clone --branch $Branch 'https://github.com/vosser24/PRISM' $Prefix
        }
    }
}

# =========================================================================
# Step 2 — Backup ~/.claude/
# =========================================================================
function Backup-ClaudeHome {
    $Script:CurrentStep = '2/backup'
    if ($NoBackup) {
        Write-InstallLog 'step 2: skipped (--no-backup)'
        return
    }
    $TS = Get-Date -Format 'yyyyMMdd_HHmmss'
    $bkp = Join-Path $env:USERPROFILE ".claude\backups\pre-prism-$TS"
    Write-InstallLog "step 2: backing up existing ~/.claude/ to $bkp"

    if ($DryRun) {
        Write-InstallLog "  DRY-RUN: New-Item -ItemType Directory -Force -Path `"$bkp`""
        foreach ($item in @('settings.json','hooks','tools','statusline-command.sh')) {
            $src = Join-Path $env:USERPROFILE ".claude\$item"
            Write-InstallLog "  DRY-RUN: Copy-Item -Recurse `"$src`" to `"$bkp`" (if exists)"
        }
        return
    }

    New-Item -ItemType Directory -Force -Path $bkp | Out-Null
    foreach ($item in @('settings.json','hooks','tools','statusline-command.sh')) {
        $src = Join-Path $env:USERPROFILE ".claude\$item"
        if (Test-Path $src) {
            Copy-Item -Recurse -Force -Path $src -Destination $bkp -ErrorAction SilentlyContinue
        }
    }
    Write-InstallLog "  backup complete: $bkp"
}

# =========================================================================
# Step 2.5 — Resolve node + write ~/.claude/prism.env
# =========================================================================
function Resolve-Node {
    $Script:CurrentStep = '2.5/node-resolution'
    Write-InstallLog 'step 2.5: resolving node absolute path for prism.env'

    $candidates = New-Object System.Collections.Generic.List[string]

    # 1. Get-Command node
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd) { $candidates.Add($nodeCmd.Source) | Out-Null }

    # 2. nvm Windows: $env:APPDATA\nvm\<latest>\node.exe
    if ($env:APPDATA) {
        $nvmRoot = Join-Path $env:APPDATA 'nvm'
        if (Test-Path $nvmRoot) {
            $latest = Get-ChildItem -Path $nvmRoot -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -match '^v?\d+\.\d+\.\d+' } |
                Sort-Object Name -Descending |
                Select-Object -First 1
            if ($latest) {
                $p = Join-Path $latest.FullName 'node.exe'
                if (Test-Path $p) { $candidates.Add($p) | Out-Null }
            }
        }
    }

    # 3. Volta: $env:LOCALAPPDATA\Volta\bin\node.exe
    if ($env:LOCALAPPDATA) {
        $voltaPath = Join-Path $env:LOCALAPPDATA 'Volta\bin\node.exe'
        if (Test-Path $voltaPath) { $candidates.Add($voltaPath) | Out-Null }
    }

    # 4. Default install: ProgramFiles\nodejs\node.exe
    if (${env:ProgramFiles}) {
        $pfPath = Join-Path ${env:ProgramFiles} 'nodejs\node.exe'
        if (Test-Path $pfPath) { $candidates.Add($pfPath) | Out-Null }
    }

    if ($candidates.Count -eq 0) {
        Write-Error "could not resolve absolute node path. Install Node.js from https://nodejs.org or set PRISM_NODE in shell env."
    }

    $resolved = $candidates[0]
    Write-InstallLog "  resolved: $resolved"

    $envFile = Join-Path $env:USERPROFILE '.claude\prism.env'
    Write-InstallLog "  writing $envFile"

    if ($DryRun) {
        Write-InstallLog "  DRY-RUN: would write PRISM_NODE=$resolved to $envFile"
        return
    }

    # Ensure parent dir exists
    $envDir = Split-Path -Parent $envFile
    if (-not (Test-Path $envDir)) {
        New-Item -ItemType Directory -Force -Path $envDir | Out-Null
    }

    # Write UTF-8 NO BOM — preserves Windows backslashes verbatim. Closes
    # the v2.7.2 BOM trap pattern.
    $content = "PRISM_NODE=$resolved`n"
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllBytes($envFile, $utf8NoBom.GetBytes($content))
    Write-InstallLog "  prism.env written (UTF-8 no BOM)"
}

# =========================================================================
# Step 3 — Manifest-driven file copy
# =========================================================================
function Copy-ManifestFiles {
    $Script:CurrentStep = '3/manifest-copy'
    Write-InstallLog 'step 3: copying framework files per manifest.json'

    $manifestPath = Join-Path $Prefix 'manifest.json'
    if (-not (Test-Path $manifestPath)) {
        # In dry-run, prefix may not be cloned yet — fall back to script-relative.
        $sourceManifest = Join-Path $PSScriptRoot '..\manifest.json'
        if ($DryRun -and (Test-Path $sourceManifest)) {
            Write-InstallLog "  DRY-RUN: prefix not yet cloned — using source manifest at $sourceManifest"
            $manifestPath = $sourceManifest
        } else {
            Write-Error "manifest.json not found at $manifestPath"
        }
    }

    $manifest = Get-Content -Raw -Path $manifestPath | ConvertFrom-Json
    $files = $manifest.files
    if (-not $files) {
        Write-Error 'manifest.json has no files[] array'
    }

    if ($DryRun) {
        Write-InstallLog "  DRY-RUN: would copy $($files.Count) manifest entries from $Prefix to ~/.claude/"
        return
    }

    $copied = 0
    $skipped = 0
    foreach ($entry in $files) {
        $src = Join-Path $Prefix $entry.src
        $dest = $entry.dest -replace '^~', $env:USERPROFILE
        $dest = $dest -replace '/', '\'

        if (-not (Test-Path $src)) {
            Write-InstallLog "  WARN: missing source $($entry.src)"
            $skipped++
            continue
        }

        $destDir = Split-Path -Parent $dest
        if (-not (Test-Path $destDir)) {
            New-Item -ItemType Directory -Force -Path $destDir | Out-Null
        }

        Copy-Item -Force -Path $src -Destination $dest
        $copied++
    }

    Write-InstallLog "  copied: $copied, skipped: $skipped (of $($files.Count) manifest entries)"
}

# =========================================================================
# Step 4 — install-merge
# =========================================================================
function Invoke-InstallMerge {
    $Script:CurrentStep = '4/install-merge'
    Write-InstallLog 'step 4: deep-merging settings.fragment.json into ~/.claude/settings.json'

    $mergeScript = Join-Path $Prefix 'scripts\install-merge.mjs'
    if (-not (Test-Path $mergeScript)) {
        if ($DryRun) {
            Write-InstallLog "  DRY-RUN: install-merge.mjs not at $Prefix yet (would be after clone)"
            return
        } else {
            Write-Error "scripts/install-merge.mjs missing in $Prefix (incomplete checkout?)"
        }
    }

    if ($DryRun) {
        Write-InstallLog "  DRY-RUN: would run: node $mergeScript"
        return
    }

    Push-Location $Prefix
    try {
        & node 'scripts\install-merge.mjs'
        if ($LASTEXITCODE -ne 0) {
            Write-Error "install-merge failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }
}

# =========================================================================
# Step 5 — verify
# =========================================================================
function Invoke-Verify {
    $Script:CurrentStep = '5/verify'
    Write-InstallLog 'step 5: verifying install'

    $verifyScript = Join-Path $Prefix 'scripts\verify.mjs'
    if (-not (Test-Path $verifyScript)) {
        if ($DryRun) {
            Write-InstallLog "  DRY-RUN: verify.mjs not at $Prefix yet (would be after clone)"
            return
        } else {
            Write-Error "scripts/verify.mjs missing in $Prefix (incomplete checkout?)"
        }
    }

    if ($DryRun) {
        Write-InstallLog "  DRY-RUN: would run: node $verifyScript"
        return
    }

    Push-Location $Prefix
    try {
        & node 'scripts\verify.mjs'
        $script:VerifyExit = $LASTEXITCODE
    } finally {
        Pop-Location
    }
}

# =========================================================================
# Step 6 — Final report
# =========================================================================
function Write-FinalReport {
    $Script:CurrentStep = '6/report'

    $manifestPath = Join-Path $Prefix 'manifest.json'
    $version = 'unknown'
    if (Test-Path $manifestPath) {
        $manifest = Get-Content -Raw -Path $manifestPath | ConvertFrom-Json
        $version = $manifest.version
    }

    $envFile = Join-Path $env:USERPROFILE '.claude\prism.env'

    Write-InstallLog ''
    Write-InstallLog '=================================================='
    Write-InstallLog "PRISM v$version install complete"
    Write-InstallLog '=================================================='
    Write-InstallLog "  repo:       $Prefix"
    Write-InstallLog "  prism.env:  $envFile"
    if (-not $NoBackup -and -not $DryRun) {
        $backupRoot = Join-Path $env:USERPROFILE '.claude\backups'
        $latestBackup = Get-ChildItem -Path $backupRoot -Directory -Filter 'pre-prism-*' -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1
        if ($latestBackup) { Write-InstallLog "  backup:     $($latestBackup.FullName)" }
    }

    if ($script:VerifyExit -and $script:VerifyExit -ne 0) {
        Write-Host ''
        Write-Warning "verify.mjs exit $script:VerifyExit — see scripts/verify.mjs output above for which checks failed"
    }

    Write-InstallLog ''
    Write-InstallLog 'next: open Claude Code in any project and run /prism-health'
}

# =========================================================================
# Main
# =========================================================================
try {
    Write-InstallLog 'PRISM installer starting'
    Write-InstallLog "  prefix=$Prefix"
    Write-InstallLog "  branch=$Branch"
    Write-InstallLog "  dry-run=$([int]$DryRun.IsPresent)"
    Write-InstallLog "  no-backup=$([int]$NoBackup.IsPresent)"
    $psPlatform = if ($null -ne $PSVersionTable.Platform) { $PSVersionTable.Platform } else { 'Win32NT' }
    Write-InstallLog "  platform=$psPlatform"

    Test-Prereq
    Sync-Repo
    Backup-ClaudeHome
    Resolve-Node
    Copy-ManifestFiles
    Invoke-InstallMerge
    Invoke-Verify
    Write-FinalReport

    if ($script:VerifyExit -and $script:VerifyExit -ne 0) {
        exit 1
    }
    exit 0
} catch {
    Write-Host ''
    Write-Host "[install] FAILED at step: $($Script:CurrentStep)" -ForegroundColor Red
    Write-Host "[install] error: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
