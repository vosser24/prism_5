# Unit tests for tools/lib/prism-state.ps1
# Run on Windows PowerShell 5.1 (or PowerShell 7+):
#   pwsh -NoProfile -ExecutionPolicy Bypass -File tests\v3\state\test-prism-state.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests\v3\state\test-prism-state.ps1
# Exit code: 0 = all pass; 1 = any failure.
#
# Critical assertion: the file written by Write-PrismStateAtomic MUST NOT have
# a UTF-8 BOM (PS 5.1 default Out-File -Encoding utf8 emits a BOM, which would
# break consumers reading via Node / cross-platform tooling).

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$root   = (Resolve-Path (Join-Path $here '..\..\..')).Path
$module = Join-Path $root 'tools\lib\prism-state.ps1'
. $module

$script:Passed = 0
$script:Failed = 0
$script:Failures = @()

function Test-Case {
    param([string]$Name, [scriptblock]$Body)
    try {
        & $Body
        $script:Passed++
        Write-Host ("  ok  " + $Name)
    } catch {
        $script:Failed++
        $script:Failures += [pscustomobject]@{ Name = $Name; Error = $_ }
        Write-Host ("  FAIL " + $Name)
        Write-Host ("        " + $_.Exception.Message)
    }
}

function Assert-True {
    param([bool]$Cond, [string]$Msg = '')
    if (-not $Cond) { throw "assertion failed: $Msg" }
}

function Assert-Eq {
    param($Actual, $Expected, [string]$Msg = '')
    $a = ($Actual   | ConvertTo-Json -Depth 32 -Compress)
    $b = ($Expected | ConvertTo-Json -Depth 32 -Compress)
    if ($a -ne $b) { throw "expected $b got $a $(if ($Msg) { "— $Msg" })" }
}

function New-TempRoot {
    param([string]$Label)
    $p = Join-Path ([System.IO.Path]::GetTempPath()) ("prism-state-test-$Label-" + [System.IO.Path]::GetRandomFileName())
    New-Item -ItemType Directory -Force -Path $p | Out-Null
    return $p
}

# --- schema basics --------------------------------------------------------

Test-Case 'New-PrismInitialState produces valid object' {
    $s = New-PrismInitialState -ProjectName 'proj'
    Assert-Eq $s.schema_version 1
    Assert-Eq $s.prism_version '3.10.0'
    Assert-Eq $s.project_name 'proj'
    Assert-Eq $s.last_sync_at $null
    Assert-Eq $s.last_command $null
    foreach ($p in @('identity','structure','discovery','roster','health')) {
        Assert-True ($null -ne $s.phases[$p]) "phase $p"
        Assert-Eq $s.phases[$p].completed_at $null
    }
}

Test-Case 'Test-PrismStateValid passes on initial state' {
    $s = New-PrismInitialState -ProjectName 'proj'
    $v = Test-PrismStateValid -State $s
    Assert-True $v.Ok ($v.Errors -join ';')
}

Test-Case 'Test-PrismStateValid rejects schema_version=0' {
    $s = New-PrismInitialState -ProjectName 'proj'
    $s.schema_version = 0
    $v = Test-PrismStateValid -State $s
    Assert-True (-not $v.Ok)
}

Test-Case 'Test-PrismStateValid rejects non-ISO date' {
    $s = New-PrismInitialState -ProjectName 'proj'
    $s.initialized_at = '2026-05-06 12:00:00'
    $v = Test-PrismStateValid -State $s
    Assert-True (-not $v.Ok)
}

# --- checksum -------------------------------------------------------------

Test-Case 'Get-PrismStateChecksum is deterministic' {
    $s = New-PrismInitialState -ProjectName 'proj'
    $a = Get-PrismStateChecksum -State $s
    $b = Get-PrismStateChecksum -State $s
    Assert-Eq $a $b
    Assert-True ($a -match '^[0-9a-f]{64}$') 'sha256 hex'
}

Test-Case 'Get-PrismStateChecksum ignores its own field' {
    $s = New-PrismInitialState -ProjectName 'proj'
    $s['checksum'] = 'aaa'
    $a = Get-PrismStateChecksum -State $s
    $s['checksum'] = 'bbb'
    $b = Get-PrismStateChecksum -State $s
    Assert-Eq $a $b
}

# --- atomic write/read round-trip + UTF-8 BOM verification ----------------

Test-Case 'Write-PrismStateAtomic + Read-PrismState round-trip' {
    $root = New-TempRoot 'rt'
    try {
        $s = New-PrismInitialState -ProjectName 'rt'
        Write-PrismStateAtomic -ProjectRoot $root -State $s | Out-Null
        $r = Read-PrismState -ProjectRoot $root
        Assert-Eq $r.Status 'ok'
        Assert-Eq $r.State.project_name 'rt'
    } finally { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
}

Test-Case 'Written file has NO UTF-8 BOM (PS 5.1 critical assertion)' {
    $root = New-TempRoot 'bom'
    try {
        $s = New-PrismInitialState -ProjectName 'rt'
        $res = Write-PrismStateAtomic -ProjectRoot $root -State $s
        $bytes = [System.IO.File]::ReadAllBytes($res.Path)
        # UTF-8 BOM = EF BB BF
        Assert-True ($bytes.Length -ge 3) 'non-empty file'
        $hasBom = ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
        Assert-True (-not $hasBom) 'BOM present — Write-PrismStateAtomic must emit UTF-8 without BOM'
    } finally { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
}

Test-Case 'Written file uses UTF-8 (decodes cleanly without BOM)' {
    $root = New-TempRoot 'utf8'
    try {
        $s = New-PrismInitialState -ProjectName 'projët'  # non-ASCII to exercise UTF-8
        Write-PrismStateAtomic -ProjectRoot $root -State $s | Out-Null
        $r = Read-PrismState -ProjectRoot $root
        Assert-Eq $r.Status 'ok'
        Assert-Eq $r.State.project_name 'projët'
    } finally { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
}

# --- failure modes on read ------------------------------------------------

Test-Case 'Read-PrismState: missing file' {
    $root = New-TempRoot 'missing'
    try {
        $r = Read-PrismState -ProjectRoot $root
        Assert-Eq $r.Status 'missing'
    } finally { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
}

Test-Case 'Read-PrismState: invalid JSON' {
    $root = New-TempRoot 'badjson'
    try {
        $dir = Join-Path $root '.claude'
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        $utf8NoBom = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText((Get-PrismStatePath -ProjectRoot $root), '{not valid json', $utf8NoBom)
        $r = Read-PrismState -ProjectRoot $root
        Assert-Eq $r.Status 'invalid_json'
    } finally { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
}

Test-Case 'Read-PrismState: checksum mismatch' {
    $root = New-TempRoot 'tamper'
    try {
        $s = New-PrismInitialState -ProjectName 'orig'
        $res = Write-PrismStateAtomic -ProjectRoot $root -State $s
        # Tamper with file (change project_name without recomputing checksum)
        $raw = [System.IO.File]::ReadAllText($res.Path)
        $tampered = $raw -replace '"project_name":\s*"orig"', '"project_name": "tampered"'
        $utf8NoBom = New-Object System.Text.UTF8Encoding $false
        [System.IO.File]::WriteAllText($res.Path, $tampered, $utf8NoBom)
        $r = Read-PrismState -ProjectRoot $root
        Assert-Eq $r.Status 'checksum_mismatch'
    } finally { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
}

# --- summary --------------------------------------------------------------

Write-Host ""
Write-Host ("$($script:Passed) passed, $($script:Failed) failed")
if ($script:Failed -gt 0) { exit 1 }
exit 0
