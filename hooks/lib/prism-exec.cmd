@echo off
REM PRISM hook node-exec wrapper for Windows (v2.3.0)
REM
REM Mirrors hooks/lib/prism-exec.sh. Resolves node.exe in this order:
REM   1. %PRISM_NODE%
REM   2. %USERPROFILE%\.claude\prism.env  (KEY=VALUE lines, parsed)
REM   3. where node
REM   4. %APPDATA%\nvm\<latest>\node.exe   (nvm-windows default)
REM   5. %LOCALAPPDATA%\fnm_multishells\*\node.exe  (best-effort)
REM   6. %LOCALAPPDATA%\Volta\bin\node.exe
REM   7. %ProgramFiles%\nodejs\node.exe
REM   8. %ProgramFiles(x86)%\nodejs\node.exe
REM
REM Missing node = exit 0 (silent no-op). Found node = exec and pass-through args.
REM Exit code mirrors node's.

setlocal EnableExtensions EnableDelayedExpansion
set "NODE_BIN="

REM 1. Env override.
if defined PRISM_NODE if exist "%PRISM_NODE%" set "NODE_BIN=%PRISM_NODE%"

REM 2. prism.env pin.
if not defined NODE_BIN if exist "%USERPROFILE%\.claude\prism.env" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%USERPROFILE%\.claude\prism.env") do (
    if /i "%%A"=="PRISM_NODE" (
      set "CAND=%%B"
      if exist "!CAND!" set "NODE_BIN=!CAND!"
    )
  )
)

REM 3. where node.
if not defined NODE_BIN (
  for /f "delims=" %%N in ('where node 2^>nul') do (
    if not defined NODE_BIN set "NODE_BIN=%%N"
  )
)

REM 4. nvm-windows. Pick the lexicographically-last versioned dir under %APPDATA%\nvm.
if not defined NODE_BIN if exist "%APPDATA%\nvm" (
  for /f "delims=" %%D in ('dir /b /ad /o-n "%APPDATA%\nvm" 2^>nul') do (
    if not defined NODE_BIN if exist "%APPDATA%\nvm\%%D\node.exe" set "NODE_BIN=%APPDATA%\nvm\%%D\node.exe"
  )
)

REM 5. fnm (best-effort — multishells are short-lived, but try).
if not defined NODE_BIN if exist "%LOCALAPPDATA%\fnm_multishells" (
  for /f "delims=" %%D in ('dir /b /ad /o-d "%LOCALAPPDATA%\fnm_multishells" 2^>nul') do (
    if not defined NODE_BIN if exist "%LOCALAPPDATA%\fnm_multishells\%%D\node.exe" set "NODE_BIN=%LOCALAPPDATA%\fnm_multishells\%%D\node.exe"
  )
)

REM 6. Volta.
if not defined NODE_BIN if exist "%LOCALAPPDATA%\Volta\bin\node.exe" set "NODE_BIN=%LOCALAPPDATA%\Volta\bin\node.exe"

REM 7-8. Program Files installs.
if not defined NODE_BIN if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_BIN if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles(x86)%\nodejs\node.exe"

if not defined NODE_BIN exit /b 0

REM Prepend node's dir so npm/npx resolve for child hooks.
for %%D in ("%NODE_BIN%") do set "NODE_DIR=%%~dpD"
set "PATH=%NODE_DIR%;%PATH%"

"%NODE_BIN%" %*
exit /b %ERRORLEVEL%
