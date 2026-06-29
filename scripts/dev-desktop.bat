@echo off
setlocal enabledelayedexpansion

echo.
echo  GRAPHY-Next dev-desktop (Windows)
echo ====================================
echo.

set "ROOT=%~dp0.."

echo [1/4] Building backend jar (tests skipped for dev)...
cd /d "%ROOT%\backend"
call mvn -q -Dfrontend.skip=true -DskipTests clean package
if %errorlevel% neq 0 (
    echo [ERROR] Backend build failed.
    pause
    exit /b 1
)
echo       Done.

if exist "%ROOT%\desktop\resources\backend" (
    rd /s /q "%ROOT%\desktop\resources\backend" >nul 2>&1
)

echo [2/4] Checking npm dependencies...
if not exist "%ROOT%\frontend\node_modules" (
    echo       Installing frontend dependencies...
    cd /d "%ROOT%\frontend"
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] frontend npm install failed.
        pause
        exit /b 1
    )
)
if not exist "%ROOT%\desktop\node_modules" (
    echo       Installing desktop dependencies...
    cd /d "%ROOT%\desktop"
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] desktop npm install failed.
        pause
        exit /b 1
    )
)
echo       Done.

echo [3/4] Starting Vite dev server on :5173...
taskkill /fi "WINDOWTITLE eq GRAPHY-Vite" /f >nul 2>&1
timeout /t 1 /nobreak >nul
start "GRAPHY-Vite" /D "%ROOT%\frontend" cmd /k "npm run dev"

echo       Waiting for Vite (up to 60s)...
set /a TRIES=0

:WAIT_LOOP
curl -s --max-time 1 -o nul http://localhost:5173
if %errorlevel% equ 0 goto VITE_READY
set /a TRIES+=1
if %TRIES% geq 120 (
    echo [ERROR] Vite did not respond within 60s.
    echo         Check the GRAPHY-Vite window for errors.
    pause
    exit /b 1
)
timeout /t 1 /nobreak >nul
goto WAIT_LOOP

:VITE_READY
echo       Vite ready (%TRIES%s)
echo.

echo [4/4] Launching Electron (GRAPHY_DEV=1)...
echo       DevTools will open automatically.
echo.

REM Prefer JAVA_HOME (used by mvn) over the system PATH java (may be Java 8).
if defined JAVA_HOME (
    set "PATH=%JAVA_HOME%\bin;%PATH%"
    echo       Java: %JAVA_HOME%
) else (
    echo [WARN] JAVA_HOME is not set. Using java from PATH.
    for /f "tokens=*" %%j in ('where java 2^>nul') do echo       Java: %%j
)
echo.

cd /d "%ROOT%\desktop"
set "GRAPHY_DEV=1"
call npm start

echo.
echo [dev-desktop] Electron exited. Stopping Vite...
taskkill /fi "WINDOWTITLE eq GRAPHY-Vite" /f >nul 2>&1
echo [dev-desktop] Done.
endlocal
