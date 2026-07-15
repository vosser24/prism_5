# PRISM installer — Windows PowerShell 5.1+ wrapper
#
# Usage:
#   pwsh .\install.ps1 [options]
#   powershell -File .\install.ps1 [options]
#
# Parameters (forwarded to prism-installer.mjs):
#   -DryRun           Simulate install; no filesystem changes
#   -NoBackup         Skip backup of existing settings/roster
#   -Quiet            Suppress progress output
#   -Home <path>      Override HOME directory (alias of -HomeDir; the internal
#                     variable is NOT named $Home — that collides with the
#                     read-only automatic $HOME and breaks param binding)
#
# Requirements:
#   - Node.js 18+ on PATH
#   - Claude Code CLI
#
# Encoding: PowerShell 5.1 default is UTF-16; this script writes no files,
# so encoding is not relevant here.

param(
    [switch]$DryRun,
    [switch]$NoBackup,
    [switch]$Quiet,
    # NB: must NOT be named $Home — that collides with PowerShell's read-only
    # automatic $HOME variable and fails at param binding ("Cannot overwrite
    # variable Home because it is read-only or constant"). Alias keeps -Home usable.
    [Alias('Home')][string]$HomeDir = ''
)

$ScriptDir    = Split-Path -Parent $MyInvocation.MyCommand.Definition
$Installer    = Join-Path $ScriptDir 'tools\prism-installer.mjs'
$ManifestPath = Join-Path $ScriptDir 'tools\install-manifest.json'
$InstallDest  = Join-Path $env:USERPROFILE '.claude'

# Read the canonical version from the manifest so the banner never drifts.
$PrismVersion = '6.0.3'
if (Test-Path $ManifestPath) {
    try { $PrismVersion = (Get-Content $ManifestPath -Raw | ConvertFrom-Json).prism_version } catch {}
}

# ─── Banner ────────────────────────────────────────────────────────────────────
Write-Host '+--------------------------------------------------+' -ForegroundColor Cyan
Write-Host "|  PRISM Installer v$PrismVersion" -ForegroundColor Cyan
Write-Host "|  Install destination: $InstallDest" -ForegroundColor Cyan
Write-Host '+--------------------------------------------------+' -ForegroundColor Cyan
Write-Host ''

# ─── Node check ────────────────────────────────────────────────────────────────
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Error 'Node.js is not on PATH. Install Node 18+ and try again.'
    Write-Host '  https://nodejs.org/' -ForegroundColor Yellow
    exit 1
}

$nodeVersionRaw = & node --version 2>&1
$nodeVersion = $nodeVersionRaw -replace '^v', ''
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 18) {
    Write-Error "Node.js 18+ required (found v$nodeVersion)."
    Write-Host '  https://nodejs.org/' -ForegroundColor Yellow
    exit 1
}

# ─── Installer check ────────────────────────────────────────────────────────────
if (-not (Test-Path $Installer)) {
    Write-Error "Installer not found at: $Installer"
    Write-Host '  Make sure you are running this script from the PRISM repo root.' -ForegroundColor Yellow
    exit 1
}

# ─── Build arg list for node installer ────────────────────────────────────────
$nodeArgs = @($Installer, 'install')
if ($DryRun)   { $nodeArgs += '--dry-run' }
if ($NoBackup) { $nodeArgs += '--no-backup' }
if ($Quiet)    { $nodeArgs += '--quiet' }
if ($HomeDir -ne '') { $nodeArgs += @('--home', $HomeDir) }

# ─── Execute ───────────────────────────────────────────────────────────────────
& node @nodeArgs
exit $LASTEXITCODE
