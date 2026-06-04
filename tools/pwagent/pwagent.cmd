@echo off
REM pwagent.cmd — cmd-shell entrypoint; delegates to the PowerShell bootstrap.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0pwagent.ps1" %*
