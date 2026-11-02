@echo off
rem GRAPHY-Next batch extraction CLI (installed app). Finds the executable and app.asar from resources\cli\
rem and runs batchCli.js with ELECTRON_RUN_AS_NODE=1. Usage: docs/batch-extraction.md
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\GRAPHY-Next.exe" "%~dp0..\app.asar\batchCli.js" %*
exit /b %ERRORLEVEL%
