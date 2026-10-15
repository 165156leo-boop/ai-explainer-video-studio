@echo off
rem Starts the local Doubao provider (browser bridge on 127.0.0.1:8012).
rem
rem Keep this window open while you work; closing it stops the provider.
rem The workbench media panel can also start the provider for you, so this
rem script is only needed when you want to launch it up front.
rem
rem ELECTRON_RUN_AS_NODE must be cleared before starting Electron. If it is
rem set (some Electron-based terminals export it), Electron would start as
rem plain Node and crash on `require("electron").app` being undefined.

setlocal
set "ELECTRON_RUN_AS_NODE="

set "PROVIDER=%~dp0..\doubao-native-provider"
if not exist "%PROVIDER%\package.json" (
  echo Cannot find the local provider at "%PROVIDER%"
  exit /b 1
)

cd /d "%PROVIDER%"
echo Starting the Doubao provider on 127.0.0.1:8012 ...
echo Keep this window open. Press Ctrl+C to stop it.
echo.
npm start
exit /b %ERRORLEVEL%
