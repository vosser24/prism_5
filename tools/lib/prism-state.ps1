# PRISM State File Module — v3.10.0 Phase 1 (PowerShell 5.1 compatible)
#
# Mirror of tools/lib/prism-state.mjs for installer / boot scripts that run
# under Windows PowerShell 5.1 (no Node available at install time).
#
# Critical PS 5.1 notes:
#   - Out-File -Encoding utf8NoBOM does NOT exist on PS 5.1. We use
#     [System.IO.File]::WriteAllText with [System.Text.UTF8Encoding]::new($false)
#     (the $false ctor arg disables the BOM).
#   - ConvertTo-Json on PS 5.1 defaults to -Depth 2; we pass -Depth 32.
#   - Use [ordered] hashtables when key order matters for JSON readability.
#   - Atomic write: write to a sibling .tmp file in the same directory, then
#     [System.IO.File]::Move($tmp, $dest, $true) (overwrite-replace).
#     Note: File.Move w/ 3-arg overload is .NET Core only; on .NET Framework
#     (PS 5.1) we Remove-Item the destination first then Move-Item. This
#     creates a small non-atomic window — acceptable because the prior file
#     has already been committed and a crash mid-rename leaves the .tmp
#     recoverable on next read.
#
# Functions exported as script-scoped (dot-source this file and call directly):
#   New-PrismInitialState  -ProjectName <string> [-Now <string>]
#   Get-PrismStatePath     -ProjectRoot <string>
#   Read-PrismState        -ProjectRoot <string>          -> [pscustomobject] @{ State; Status; Errors; Raw }
#   Write-PrismStateAtomic -ProjectRoot <string> -State <object>
#   Test-PrismStateValid   -State <object>                -> [pscustomobject] @{ Ok; Errors }
#   Get-PrismStateChecksum -State <object>                -> [string] sha256 hex
#   Test-PrismStateChecksum -State <object>               -> [bool]

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:PrismSchemaVersion   = 1
$script:PrismProductVersion  = '3.10.0'
$script:PrismStateDir        = '.claude'
$script:PrismStateFilename   = '.prism-state.json'
$script:PrismPhases          = @('identity','structure','discovery','roster','health')
$script:PrismMaxPhaseFailures = 10

function Get-PrismNowIso {
    # ms-precision UTC matching JS new Date().toISOString()
    return (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
}

function Get-PrismStateDir {
    param([Parameter(Mandatory)][string]$ProjectRoot)
    return (Join-Path $ProjectRoot $script:PrismStateDir)
}

function Get-PrismStatePath {
    param([Parameter(Mandatory)][string]$ProjectRoot)
    return (Join-Path (Get-PrismStateDir -ProjectRoot $ProjectRoot) $script:PrismStateFilename)
}

function New-PrismInitialState {
    param(
        [Parameter(Mandatory)][string]$ProjectName,
        [string]$Now
    )
    if (-not $Now) { $Now = Get-PrismNowIso }
    $phases = [ordered]@{}
    foreach ($p in $script:PrismPhases) {
        $phases[$p] = [ordered]@{ completed_at = $null }
    }
    $state = [ordered]@{
        schema_version        = $script:PrismSchemaVersion
        prism_version         = $script:PrismProductVersion
        project_name          = [string]$ProjectName
        initialized_at        = $Now
        last_run              = $Now
        last_sync_at          = $null
        next_sync_recommended = $null
        phases                = $phases
        last_command          = $null
        phase_failures        = @()
        checksum              = $null
    }
    return $state
}

# Deterministic canonicalization for hashing: sort keys alphabetically at every
# level. Returns a JSON string.
function ConvertTo-PrismCanonicalJson {
    param([Parameter(Mandatory)][AllowNull()]$Value)
    return (_PrismCanonicalize $Value | ConvertTo-Json -Depth 64 -Compress)
}

function _PrismCanonicalize {
    param([AllowNull()]$v)
    if ($null -eq $v) { return $null }
    if ($v -is [string] -or $v -is [bool] -or $v -is [int] -or $v -is [long] -or $v -is [double] -or $v -is [decimal]) {
        return $v
    }
    if ($v -is [System.Collections.IDictionary]) {
        $sorted = [ordered]@{}
        foreach ($k in ($v.Keys | Sort-Object)) {
            $sorted[$k] = _PrismCanonicalize $v[$k]
        }
        return $sorted
    }
    if ($v -is [System.Collections.IEnumerable] -and -not ($v -is [string])) {
        $arr = @()
        foreach ($item in $v) { $arr += ,(_PrismCanonicalize $item) }
        return ,$arr
    }
    # PSCustomObject (from ConvertFrom-Json)
    if ($v -is [pscustomobject]) {
        $sorted = [ordered]@{}
        foreach ($prop in ($v.PSObject.Properties.Name | Sort-Object)) {
            $sorted[$prop] = _PrismCanonicalize $v.$prop
        }
        return $sorted
    }
    return $v
}

function Get-PrismStateChecksum {
    param([Parameter(Mandatory)]$State)
    # Strip checksum field
    $copy = _PrismStripChecksum $State
    $json = ConvertTo-PrismCanonicalJson -Value $copy
    $sha  = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
        $hash  = $sha.ComputeHash($bytes)
        return -join ($hash | ForEach-Object { $_.ToString('x2') })
    } finally { $sha.Dispose() }
}

function _PrismStripChecksum {
    param($v)
    if ($v -is [System.Collections.IDictionary]) {
        $copy = [ordered]@{}
        foreach ($k in $v.Keys) {
            if ($k -eq 'checksum') { continue }
            $copy[$k] = $v[$k]
        }
        return $copy
    }
    if ($v -is [pscustomobject]) {
        $copy = [ordered]@{}
        foreach ($prop in $v.PSObject.Properties.Name) {
            if ($prop -eq 'checksum') { continue }
            $copy[$prop] = $v.$prop
        }
        return $copy
    }
    return $v
}

function _PrismGetField {
    param($obj, [string]$name)
    if ($null -eq $obj) { return $null }
    if ($obj -is [System.Collections.IDictionary]) {
        if ($obj.Contains($name)) { return $obj[$name] } else { return $null }
    }
    if ($obj -is [pscustomobject]) {
        $p = $obj.PSObject.Properties[$name]
        if ($p) { return $p.Value } else { return $null }
    }
    return $null
}

function _PrismHasField {
    param($obj, [string]$name)
    if ($null -eq $obj) { return $false }
    if ($obj -is [System.Collections.IDictionary]) { return $obj.Contains($name) }
    if ($obj -is [pscustomobject]) { return [bool]$obj.PSObject.Properties[$name] }
    return $false
}

function Test-PrismStateValid {
    param([Parameter(Mandatory)][AllowNull()]$State)
    $errors = New-Object System.Collections.Generic.List[string]
    if ($null -eq $State -or -not (($State -is [System.Collections.IDictionary]) -or ($State -is [pscustomobject]))) {
        $errors.Add('state is not an object')
        return [pscustomobject]@{ Ok = $false; Errors = $errors.ToArray() }
    }
    $sv = _PrismGetField $State 'schema_version'
    if (-not ($sv -is [int]) -or $sv -lt 1) { $errors.Add('schema_version must be a positive integer') }
    $pv = _PrismGetField $State 'prism_version'
    if (-not ($pv -is [string]) -or [string]::IsNullOrEmpty($pv)) { $errors.Add('prism_version must be a non-empty string') }
    $pn = _PrismGetField $State 'project_name'
    if (-not ($pn -is [string])) { $errors.Add('project_name must be a string') }

    $isoRe = '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$'
    foreach ($f in @('initialized_at','last_run')) {
        $val = _PrismGetField $State $f
        if (-not ($val -is [string]) -or ($val -notmatch $isoRe)) { $errors.Add("$f must be ISO-8601") }
    }
    foreach ($f in @('last_sync_at','next_sync_recommended')) {
        $val = _PrismGetField $State $f
        if ($null -ne $val -and (-not ($val -is [string]) -or ($val -notmatch $isoRe))) {
            $errors.Add("$f must be ISO-8601 or null")
        }
    }
    $phases = _PrismGetField $State 'phases'
    if ($null -eq $phases) {
        $errors.Add('phases must be an object')
    } else {
        foreach ($p in $script:PrismPhases) {
            $ph = _PrismGetField $phases $p
            if ($null -eq $ph) { $errors.Add("phases.$p missing"); continue }
            if (-not (_PrismHasField $ph 'completed_at')) {
                $errors.Add("phases.$p.completed_at missing")
            } else {
                $ca = _PrismGetField $ph 'completed_at'
                if ($null -ne $ca -and (-not ($ca -is [string]) -or ($ca -notmatch $isoRe))) {
                    $errors.Add("phases.$p.completed_at must be ISO-8601 or null")
                }
            }
        }
    }
    $lc = _PrismGetField $State 'last_command'
    if ($null -ne $lc -and -not ($lc -is [string])) { $errors.Add('last_command must be string or null') }
    $pf = _PrismGetField $State 'phase_failures'
    if ($null -eq $pf -or -not ($pf -is [System.Collections.IEnumerable]) -or ($pf -is [string])) {
        $errors.Add('phase_failures must be an array')
    } elseif (@($pf).Count -gt $script:PrismMaxPhaseFailures) {
        $errors.Add("phase_failures exceeds cap of $($script:PrismMaxPhaseFailures)")
    }
    return [pscustomobject]@{ Ok = ($errors.Count -eq 0); Errors = $errors.ToArray() }
}

function Test-PrismStateChecksum {
    param([Parameter(Mandatory)]$State)
    $stored = _PrismGetField $State 'checksum'
    if (-not ($stored -is [string])) { return $false }
    return ((Get-PrismStateChecksum -State $State) -eq $stored)
}

function Read-PrismState {
    param([Parameter(Mandatory)][string]$ProjectRoot)
    $path = Get-PrismStatePath -ProjectRoot $ProjectRoot
    if (-not (Test-Path -LiteralPath $path)) {
        return [pscustomobject]@{ State = $null; Status = 'missing'; Errors = @(); Raw = $null }
    }
    try {
        $raw = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
    } catch {
        return [pscustomobject]@{ State = $null; Status = 'unreadable'; Errors = @($_.Exception.Message); Raw = $null }
    }
    try {
        $parsed = $raw | ConvertFrom-Json
    } catch {
        return [pscustomobject]@{ State = $null; Status = 'invalid_json'; Errors = @($_.Exception.Message); Raw = $raw }
    }
    $v = Test-PrismStateValid -State $parsed
    if (-not $v.Ok) {
        return [pscustomobject]@{ State = $parsed; Status = 'invalid_schema'; Errors = $v.Errors; Raw = $raw }
    }
    if (-not (Test-PrismStateChecksum -State $parsed)) {
        return [pscustomobject]@{ State = $parsed; Status = 'checksum_mismatch'; Errors = @('checksum mismatch'); Raw = $raw }
    }
    return [pscustomobject]@{ State = $parsed; Status = 'ok'; Errors = @(); Raw = $raw }
}

function Write-PrismStateAtomic {
    param(
        [Parameter(Mandatory)][string]$ProjectRoot,
        [Parameter(Mandatory)]$State
    )
    $v = Test-PrismStateValid -State $State
    if (-not $v.Ok) { throw "refusing to write invalid state: $($v.Errors -join '; ')" }

    $dir  = Get-PrismStateDir -ProjectRoot $ProjectRoot
    $path = Get-PrismStatePath -ProjectRoot $ProjectRoot
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

    # Stamp checksum
    $stamped = _PrismCloneOrdered $State
    if (_PrismHasField $stamped 'checksum') { $stamped['checksum'] = $null }
    $stamped['checksum'] = Get-PrismStateChecksum -State $stamped

    $json = ($stamped | ConvertTo-Json -Depth 64) + "`n"

    $tmp = "$path.tmp.$PID.$([System.IO.Path]::GetRandomFileName())"

    # CRITICAL: PS 5.1 has no utf8NoBOM. Use .NET WriteAllText with explicit
    # UTF8Encoding($false) so no BOM is emitted.
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($tmp, $json, $utf8NoBom)

    # Replace target. On .NET Framework (PS 5.1), File.Move is 2-arg only.
    try {
        if (Test-Path -LiteralPath $path) {
            # Best-effort replace via Move-Item -Force (which deletes target first).
            Move-Item -LiteralPath $tmp -Destination $path -Force
        } else {
            Move-Item -LiteralPath $tmp -Destination $path
        }
    } catch {
        try { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue } catch {}
        throw
    }
    return [pscustomobject]@{ Path = $path; Checksum = $stamped['checksum'] }
}

function _PrismCloneOrdered {
    param($v)
    if ($v -is [System.Collections.IDictionary]) {
        $copy = [ordered]@{}
        foreach ($k in $v.Keys) { $copy[$k] = _PrismCloneOrdered $v[$k] }
        return $copy
    }
    if ($v -is [pscustomobject]) {
        $copy = [ordered]@{}
        foreach ($prop in $v.PSObject.Properties.Name) { $copy[$prop] = _PrismCloneOrdered $v.$prop }
        return $copy
    }
    if ($v -is [System.Collections.IEnumerable] -and -not ($v -is [string])) {
        $arr = @()
        foreach ($item in $v) { $arr += ,(_PrismCloneOrdered $item) }
        return ,$arr
    }
    return $v
}
