@echo off
rem GRAPHY Portable 2D Viewer launcher (Windows). Double-click to open the viewer for this media.
cd /d "%~dp0"
if not exist "VIEWER\serve.ps1" (
  echo VIEWER\serve.ps1 was not found. Keep this file next to the VIEWER folder.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0VIEWER\serve.ps1" -Root "%~dp0."
if errorlevel 1 pause
