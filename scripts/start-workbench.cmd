@echo off
rem One-key entry for the workbench launcher.
rem Windows blocks .ps1 files under the default execution policy, so this
rem wrapper starts PowerShell with -ExecutionPolicy Bypass for this call only.
rem The launcher rebuilds, starts the server and opens it in your browser at
rem http://localhost:3001/ (browser storage is per origin, so always use
rem "localhost" rather than 127.0.0.1 to keep your remembered project).
rem Double-click this file, or run it from any terminal:
rem   scripts\start-workbench.cmd            (build + start + open browser)
rem   scripts\start-workbench.cmd -Port 3005
rem   scripts\start-workbench.cmd -NoBrowser
rem   scripts\start-workbench.cmd -SkipBuild

setlocal
set "SCRIPT=%~dp0start-workbench.ps1"

if not exist "%SCRIPT%" (
  echo Cannot find "%SCRIPT%"
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
exit /b %ERRORLEVEL%
