@echo off
rem GRAPHY-Next MCP relay graphy-mcp (installed app; started by an external AI client). Finds the executable and app.asar from resources\cli\
rem and runs mcpCli.js with ELECTRON_RUN_AS_NODE=1. stdout is the MCP channel: print nothing here.
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\GRAPHY-Next.exe" "%~dp0..\app.asar\mcpCli.js" %*
exit /b %ERRORLEVEL%
