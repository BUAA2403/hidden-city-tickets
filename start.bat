@echo off
setlocal
cd /d "%~dp0"

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
"%NODE_CMD%" server.js --open
set "APP_EXIT=%errorlevel%"
if "%APP_EXIT%"=="0" exit /b 0
echo.
echo Server stopped (errorlevel %APP_EXIT%).
pause
exit /b %APP_EXIT%
