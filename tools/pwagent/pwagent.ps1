# pwagent.ps1 — self-bootstrapping venv wrapper.
# Idempotent: creates .venv (from Python 3.12) + installs deps + Chromium on
# first run, then ALWAYS invokes the CLI via the venv's python directly. A
# requirements-hash guard reinstalls deps when requirements.txt changes.
$ErrorActionPreference = "Stop"

$root     = $PSScriptRoot
$venv     = Join-Path $root ".venv"
$venvPy   = Join-Path $venv "Scripts\python.exe"
$reqs     = Join-Path $root "requirements.txt"
$hashFile = Join-Path $venv ".reqs.hash"

# Resolve a system Python 3.12 to build the venv from. Prefer the known install
# path; fall back to whatever `python` is on PATH.
$sysPy = "C:\Program Files\Python312\python.exe"
if (-not (Test-Path $sysPy)) {
    $found = (Get-Command python -ErrorAction SilentlyContinue).Source
    if ($found) { $sysPy = $found } else { throw "Python 3.12 not found (looked at C:\Program Files\Python312\python.exe and PATH)" }
}

function Install-Deps {
    Write-Host "[pwagent] upgrading pip + installing requirements..." -ForegroundColor Cyan
    & $venvPy -m pip install --upgrade pip
    & $venvPy -m pip install -r $reqs

    Write-Host "[pwagent] installing Chromium (first run only, ~150MB)..." -ForegroundColor Cyan
    & $venvPy -m playwright install chromium

    Write-Host "[pwagent] verifying dependency tree (pip check)..." -ForegroundColor Cyan
    & $venvPy -m pip check

    (Get-FileHash $reqs -Algorithm SHA256).Hash | Set-Content -Path $hashFile -Encoding ascii
}

if (-not (Test-Path $venvPy)) {
    Write-Host "[pwagent] creating venv (.venv)..." -ForegroundColor Cyan
    & $sysPy -m venv $venv
    if (-not (Test-Path $venvPy)) { throw "venv creation failed" }
    Install-Deps
    Write-Host "[pwagent] venv ready." -ForegroundColor Green
}
else {
    # Drift guard: reinstall if requirements.txt changed since the last install.
    $want = (Get-FileHash $reqs -Algorithm SHA256).Hash
    $have = if (Test-Path $hashFile) { (Get-Content $hashFile -Raw).Trim() } else { "" }
    if ($want -ne $have) {
        Write-Host "[pwagent] requirements.txt changed - reinstalling deps..." -ForegroundColor Yellow
        Install-Deps
    }
}

# Calling the venv python directly IS the activation. Add src to the path so the
# package resolves; PYTHONNOUSERSITE is defense-in-depth.
$env:PYTHONPATH       = Join-Path $root "src"
$env:PYTHONNOUSERSITE = "1"
& $venvPy -m pwagent @args
exit $LASTEXITCODE
