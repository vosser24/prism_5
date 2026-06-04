# pwagent.ps1 — self-bootstrapping venv wrapper.
# Idempotent: creates .venv (from a system Python) + installs deps + Chromium on
# first run, then ALWAYS invokes the CLI via the venv's python directly. A
# requirements-hash guard reinstalls deps when requirements.txt changes.
$ErrorActionPreference = "Stop"

$root     = $PSScriptRoot
$venv     = Join-Path $root ".venv"
$venvPy   = Join-Path $venv "Scripts\python.exe"
$reqs     = Join-Path $root "requirements.txt"
$hashFile = Join-Path $venv ".reqs.hash"

# Resolve a system Python to build the venv from. Adopt whatever `python` is on
# PATH first (pwagent sources are 3.9-compatible). $env:PWAGENT_PYTHON overrides;
# a known 3.12 install is the last-resort fallback.
$sysPy = $env:PWAGENT_PYTHON
if (-not $sysPy) { $sysPy = (Get-Command python -ErrorAction SilentlyContinue).Source }
if (-not $sysPy) {
    $fallback = "C:\Program Files\Python312\python.exe"
    if (Test-Path $fallback) { $sysPy = $fallback } else { throw "No Python found (set `$env:PWAGENT_PYTHON, put python on PATH, or install to C:\Program Files\Python312\python.exe)" }
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
