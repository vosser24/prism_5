# install-statusline-only.ps1 — standalone PRISM statusline installer (Windows PowerShell)
# Downloads statusline-command.sh from the public PRISM repo and wires it
# into ~/.claude/settings.json. No full PRISM install needed.
# PowerShell 5.1+ compatible. No PS7-only syntax.
#
# Usage:
#   .\scripts\install-statusline-only.ps1
#   iwr -UseBasicParsing https://raw.githubusercontent.com/vosser24/PRISM/claude/audit-pending-pushes-Rg1p8/scripts/install-statusline-only.ps1 | iex
Set-StrictMode -Version 2

$ErrorActionPreference = "Stop"

$REPO_RAW  = "https://raw.githubusercontent.com/vosser24/PRISM/claude/audit-pending-pushes-Rg1p8"
$SRC_FILE  = "statusline-command.sh"
$LOG_PREFIX = "[install-statusline]"

function Log-Step {
    param([string]$Msg)
    Write-Host ($LOG_PREFIX + " " + $Msg)
}

function Fail-Step {
    param([string]$Msg)
    Write-Error ($LOG_PREFIX + " ERROR: " + $Msg)
    exit 1
}

# ---------- prereq checks ----------
$nodeFound = $null
try { $nodeFound = (Get-Command node -ErrorAction SilentlyContinue) } catch {}
if (-not $nodeFound) {
    Fail-Step "node is required but not found in PATH. Install Node.js and retry."
}

# Invoke-WebRequest is built-in on Windows — no check needed.

# ---------- resolve home ----------
$HomeDir = $env:USERPROFILE
if (-not $HomeDir) {
    $HomeDir = $env:HOME
}
if (-not $HomeDir) {
    Fail-Step "Cannot determine home directory (USERPROFILE and HOME both unset)."
}
$ClaudeDir = $HomeDir + "\.claude"
$Dest      = $ClaudeDir + "\" + $SRC_FILE

Log-Step ("Claude dir: " + $ClaudeDir)

# ---------- create target directory ----------
if (-not (Test-Path $ClaudeDir)) {
    New-Item -ItemType Directory -Force -Path $ClaudeDir | Out-Null
    Log-Step ("Created " + $ClaudeDir)
}

# ---------- download statusline script ----------
$Url = $REPO_RAW + "/" + $SRC_FILE
Log-Step ("Downloading " + $Url)
try {
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Dest
} catch {
    Fail-Step ("Download failed: " + $Url + " — " + $_.Exception.Message)
}
Log-Step ("Saved to " + $Dest)

# ---------- patch settings.json via node ----------
Log-Step ("Patching " + $ClaudeDir + "\settings.json ...")

# Build the node one-liner with string concatenation (no $() interpolation in strings)
$DestFwd = $Dest.Replace("\", "/")

$NodeScript = "var fs=require('fs');" +
    "var path=require('path');" +
    "var os=require('os');" +
    "var home=process.env.USERPROFILE||process.env.HOME||os.homedir();" +
    "var p=path.join(home,'.claude','settings.json');" +
    "var cur={};" +
    "if(fs.existsSync(p)){try{cur=JSON.parse(fs.readFileSync(p,'utf8'));}catch(e){process.stderr.write('[install-statusline] WARNING: could not parse existing settings.json\n');}}" +
    "var dest=path.join(home,'.claude','statusline-command.sh').replace(/\\\\/g,'/');" +
    "cur.statusLine={type:'command',command:'bash '+dest,padding:0};" +
    "fs.writeFileSync(p,JSON.stringify(cur,null,2)+'\n');" +
    "console.log('[install-statusline] settings.json patched');"

$Result = & node -e $NodeScript 2>&1
if ($LASTEXITCODE -ne 0) {
    Fail-Step ("node patch step failed: " + $Result)
}
Write-Host $Result

# ---------- done ----------
Log-Step "Done. Restart Claude Code to activate the statusline."
exit 0
