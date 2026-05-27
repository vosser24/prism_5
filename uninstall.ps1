# PRISM v4.4.0 uninstaller — Windows PowerShell 5.1+ wrapper
#
# Usage:
#   pwsh .\uninstall.ps1 [options]
#   powershell -File .\uninstall.ps1 [options]
#
# Parameters (forwarded to prism-installer.mjs):
#   -RestoreBackup <path>   Restore settings/roster from a backup directory
#   -Quiet                  Suppress progress output
#   -Home <path>            Override HOME directory
#
# Note: state files (.prism-*.jsonl, prism-policy.json, etc.) are always preserved.
# To fully clean, manually delete ~/.claude/.prism-* files after uninstall.
#
# Requirements:
#   - Node.js 18+ on PATH

param(
    [string]$RestoreBackup = '',
    [switch]$Quiet,
    [string]$Home = ''
)

$PrismVersion = '4.4.0'
$ScriptDir    = Split-Path -Parent $MyInvocation.MyCommand.Definition
$Installer    = Join-Path $ScriptDir 'tools\prism-installer.mjs'
$InstallDest  = Join-Path $env:USERPROFILE '.claude'

# ─── Banner ────────────────────────────────────────────────────────────────────
Write-Host '+--------------------------------------------------+' -ForegroundColor Yellow
Write-Host "|  PRISM Uninstaller v$PrismVersion" -ForegroundColor Yellow
Write-Host "|  Removing from: $InstallDest" -ForegroundColor Yellow
Write-Host '+--------------------------------------------------+' -ForegroundColor Yellow
Write-Host ''

# ─── Node check ────────────────────────────────────────────────────────────────
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Error 'Node.js is not on PATH. Install Node 18+ and try again.'
    exit 1
}

$nodeVersionRaw = & node --version 2>&1
$nodeVersion = $nodeVersionRaw -replace '^v', ''
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 18) {
    Write-Error "Node.js 18+ required (found v$nodeVersion)."
    exit 1
}

# ─── Installer check ────────────────────────────────────────────────────────────
if (-not (Test-Path $Installer)) {
    Write-Error "Installer not found at: $Installer"
    Write-Host '  Make sure you are running this script from the PRISM repo root.' -ForegroundColor Yellow
    exit 1
}

# ─── Build arg list ────────────────────────────────────────────────────────────
$nodeArgs = @($Installer, 'uninstall')
if ($RestoreBackup -ne '') { $nodeArgs += @('--restore-backup', $RestoreBackup) }
if ($Quiet)     { $nodeArgs += '--quiet' }
if ($Home -ne '') { $nodeArgs += @('--home', $Home) }

# ─── Execute ───────────────────────────────────────────────────────────────────
& node @nodeArgs
exit $LASTEXITCODE
