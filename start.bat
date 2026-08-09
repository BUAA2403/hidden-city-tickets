@echo off
setlocal
cd /d "%~dp0"

rem ---- read PORT from .env (default 3000) ----
set "APP_PORT=3000"
if exist ".env" (
  for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
    if /i "%%A"=="PORT" set "APP_PORT=%%B"
  )
)

rem ---- if the port is already listening, the service is running ----
netstat -ano | findstr /R /C:":%APP_PORT% .*LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo.
  echo Hidden City Finder is already running at http://localhost:%APP_PORT%
  echo Opening the browser...
  explorer "http://localhost:%APP_PORT%"
  ping -n 3 127.0.0.1 >nul
  exit /b 0
)

set "NODE_CMD="
where node >nul 2>nul && set "NODE_CMD=node"

if not defined NODE_CMD if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "NODE_CMD=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE_CMD if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_CMD=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_CMD if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_CMD=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_CMD if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_CMD=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_CMD if exist "%~dp0node.exe" set "NODE_CMD=%~dp0node.exe"

if not defined NODE_CMD (
  echo Node.js not found. Please install Node.js 18 or later from https://nodejs.org
  echo Then run this file again, or run:  node server.js
  pause
  exit /b 1
)

echo Starting Hidden City Finder with %NODE_CMD% ...
"%NODE_CMD%" server.js
echo.
echo Server stopped (errorlevel %errorlevel%).
pause
