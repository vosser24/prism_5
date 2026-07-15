# prism-state — PowerShell CLI wrapper around tools/lib/prism-state.ps1.
#
# Phase 1 hand-driver for Windows reviewers (PS 5.1 compatible).
#
# Usage (run from any project root, or pass -Root <path>):
#
#   .\tools\prism-state.ps1 init <project-name>
#   .\tools\prism-state.ps1 read
#   .\tools\prism-state.ps1 show
#   .\tools\prism-state.ps1 validate
#   .\tools\prism-state.ps1 phase complete <name> [-Meta '{"k":v}']
#   .\tools\prism-state.ps1 phase fail     <name> "<error message>"
#   .\tools\prism-state.ps1 simulate-corrupt <bom|json|schema|checksum|tmp>
#   .\tools\prism-state.ps1 reset
#   .\tools\prism-state.ps1 path
#
# Phases: identity | structure | discovery | roster | health
#
# Refuses to run unless the target directory has a .git/ (use -NoGitGuard
# for testbed-only override).

[CmdletBinding(PositionalBinding=$false)]
param(
    [Parameter(Position=0, Mandatory=$true)] [string]$Command,
    [Parameter(Position=1, ValueFromRemainingArguments=$true)] [string[]]$Rest = @(),
    [string]$Root = (Get-Location).Path,
    [string]$Meta,
    [switch]$NoGitGuard
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$module = Join-Path $here 'lib\prism-state.ps1'
. $module

if (-not $NoGitGuard.IsPresent -and -not (Test-Path -LiteralPath (Join-Path $Root '.git'))) {
    Write-Error "refusing to run: $Root has no .git/. Pass -NoGitGuard to override (testbed only)."
    exit 2
}

function Write-Json($obj) { $obj | ConvertTo-Json -Depth 64 }

try {
    switch ($Command) {
        'init' {
            if ($Rest.Count -lt 1) { throw 'init requires <project-name>' }
            $existing = Read-PrismState -ProjectRoot $Root
            if ($existing.Status -eq 'ok') { throw "state already initialized: $(Get-PrismStatePath -ProjectRoot $Root)" }
            $s = New-PrismInitialState -ProjectName $Rest[0]
            $r = Write-PrismStateAtomic -ProjectRoot $Root -State $s
            Write-Host "initialized: $($r.Path)"
            Write-Host "checksum: $($r.Checksum)"
        }
        'read' {
            $r = Read-PrismState -ProjectRoot $Root
            $payload = [ordered]@{ status = $r.Status; errors = $r.Errors; state = $r.State }
            Write-Json $payload
            if ($r.Status -ne 'ok') { exit 1 }
        }
        'show' {
            $path = Get-PrismStatePath -ProjectRoot $Root
            if (-not (Test-Path -LiteralPath $path)) { Write-Error 'no state file'; exit 1 }
            [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8) | Write-Host
        }
        'validate' {
            $r = Read-PrismState -ProjectRoot $Root
            $schemaOk = if ($r.State) { (Test-PrismStateValid -State $r.State).Ok } else { $false }
            $sumOk = if ($r.State) { Test-PrismStateChecksum -State $r.State } else { $false }
            Write-Host "status: $($r.Status)"
            Write-Host "schema_ok: $schemaOk"
            Write-Host "checksum_ok: $sumOk"
            if ($r.Errors -and $r.Errors.Count -gt 0) {
                Write-Host 'errors:'
                foreach ($e in $r.Errors) { Write-Host "  - $e" }
            }
            if ($r.Status -ne 'ok') { exit 1 }
        }
        'phase' {
            if ($Rest.Count -lt 2) { throw 'phase requires <complete|fail> <name>' }
            $sub  = $Rest[0]
            $name = $Rest[1]
            $valid = @('identity','structure','discovery','roster','health')
            if ($valid -notcontains $name) { throw "unknown phase: $name (valid: $($valid -join ', '))" }
            $r = Read-PrismState -ProjectRoot $Root
            if ($r.Status -ne 'ok') { throw "cannot mutate: state status is $($r.Status)" }
            $state = $r.State
            switch ($sub) {
                'complete' {
                    $metaObj = @{}
                    if ($Meta) {
                        try { $metaObj = $Meta | ConvertFrom-Json } catch { throw "-Meta is not valid JSON: $($_.Exception.Message)" }
                    }
                    # Mutate phase entry
                    $now = Get-PrismNowIso
                    $existing = if ($state.phases.PSObject.Properties[$name]) { $state.phases.$name } else { [pscustomobject]@{} }
                    $merged = [ordered]@{}
                    if ($existing -is [pscustomobject]) {
                        foreach ($p in $existing.PSObject.Properties.Name) { $merged[$p] = $existing.$p }
                    } elseif ($existing -is [System.Collections.IDictionary]) {
                        foreach ($k in $existing.Keys) { $merged[$k] = $existing[$k] }
                    }
                    if ($metaObj -is [pscustomobject]) {
                        foreach ($p in $metaObj.PSObject.Properties.Name) { $merged[$p] = $metaObj.$p }
                    } elseif ($metaObj -is [System.Collections.IDictionary]) {
                        foreach ($k in $metaObj.Keys) { $merged[$k] = $metaObj[$k] }
                    }
                    $merged['completed_at'] = $now
                    # Write back
                    $state.phases.$name = $merged
                    $state.last_run = $now
                    if ($state.last_command -is [string] -and $state.last_command -like "*$name*") { $state.last_command = $null }
                }
                'fail' {
                    if ($Rest.Count -lt 3) { throw 'phase fail requires <error-message>' }
                    $err = ($Rest[2..($Rest.Count-1)] -join ' ')
                    $now = Get-PrismNowIso
                    $failures = @($state.phase_failures)
                    $failures += [ordered]@{ phase = $name; at = $now; error = $err }
                    while ($failures.Count -gt 10) { $failures = $failures[1..($failures.Count-1)] }
                    $state.phase_failures = $failures
                    $state.last_run = $now
                }
                default { throw "phase subcommand must be complete|fail, got $sub" }
            }
            Write-PrismStateAtomic -ProjectRoot $Root -State $state | Out-Null
            Write-Host "phase $name $(if ($sub -eq 'complete') { 'completed' } else { 'failed' })"
        }
        'simulate-corrupt' {
            if ($Rest.Count -lt 1) { throw 'simulate-corrupt requires <bom|json|schema|checksum|tmp>' }
            $kind = $Rest[0]
            $path = Get-PrismStatePath -ProjectRoot $Root
            if (-not (Test-Path -LiteralPath $path) -and $kind -ne 'tmp') { Write-Error 'no state file; run init first'; exit 1 }
            switch ($kind) {
                'bom' {
                    $bytes = [System.IO.File]::ReadAllBytes($path)
                    $bom = [byte[]](0xEF,0xBB,0xBF)
                    $combined = New-Object byte[] ($bom.Length + $bytes.Length)
                    [Array]::Copy($bom, 0, $combined, 0, $bom.Length)
                    [Array]::Copy($bytes, 0, $combined, $bom.Length, $bytes.Length)
                    [System.IO.File]::WriteAllBytes($path, $combined)
                    Write-Host 'injected UTF-8 BOM at byte 0'
                }
                'json' {
                    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
                    [System.IO.File]::WriteAllText($path, '{this is not json', $utf8NoBom)
                    Write-Host 'overwrote state with invalid JSON'
                }
                'schema' {
                    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
                    [System.IO.File]::WriteAllText($path, '{"foo":"bar"}', $utf8NoBom)
                    Write-Host 'overwrote state with schema-violating object'
                }
                'checksum' {
                    $raw = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
                    $obj = $raw | ConvertFrom-Json
                    $obj.project_name = "tampered-$([DateTime]::UtcNow.Ticks)"
                    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
                    [System.IO.File]::WriteAllText($path, ($obj | ConvertTo-Json -Depth 64), $utf8NoBom)
                    Write-Host 'mutated project_name without recomputing checksum'
                }
                'tmp' {
                    $dir = Get-PrismStateDir -ProjectRoot $Root
                    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
                    $stray = "$path.tmp.99999.deadbeef"
                    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
                    [System.IO.File]::WriteAllText($stray, "partial garbage`n", $utf8NoBom)
                    Write-Host "dropped stray temp file: $stray"
                }
                default { throw 'simulate-corrupt requires <bom|json|schema|checksum|tmp>' }
            }
        }
        'reset' {
            $path = Get-PrismStatePath -ProjectRoot $Root
            if (Test-Path -LiteralPath $path) {
                Remove-Item -LiteralPath $path -Force
                Write-Host "removed $path"
            } else {
                Write-Host 'no state file to remove'
            }
            $dir = Get-PrismStateDir -ProjectRoot $Root
            if (Test-Path -LiteralPath $dir) {
                Get-ChildItem -LiteralPath $dir -Force -File | Where-Object { $_.Name -like '*.tmp.*' } | ForEach-Object {
                    Remove-Item -LiteralPath $_.FullName -Force
                    Write-Host "removed $($_.FullName)"
                }
            }
        }
        'path' {
            Write-Host (Get-PrismStatePath -ProjectRoot $Root)
        }
        default { throw "unknown command: $Command" }
    }
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
