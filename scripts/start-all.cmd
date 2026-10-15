@echo off
rem One-key entry: start the local Doubao provider AND the workbench together.
rem
rem Double-click this file (or run it from any normal terminal). It opens two
rem windows:
rem   1. "Doubao Provider"  - the browser bridge on 127.0.0.1:8012
rem   2. the workbench      - builds, then opens http://localhost:3001/
rem
rem Keep both windows open while you work; closing a window stops that service.
rem All paths are derived from this file's own location.

setlocal
set "PROVIDER_SCRIPT=%~dp0start-provider.cmd"
set "WORKBENCH_SCRIPT=%~dp0start-workbench.cmd"

if not exist "%PROVIDER_SCRIPT%" (
  echo Cannot find "%PROVIDER_SCRIPT%"
  exit /b 1
)
if not exist "%WORKBENCH_SCRIPT%" (
  echo Cannot find "%WORKBENCH_SCRIPT%"
  exit /b 1
)

echo Starting the local Doubao provider in its own window ...
start "Doubao Provider (keep open)" "%PROVIDER_SCRIPT%"

echo.
echo Starting the workbench: it rebuilds first, then opens your browser at
echo http://localhost:3001/ . The first build can take a couple of minutes.
echo.
call "%WORKBENCH_SCRIPT%"
exit /b %ERRORLEVEL%
