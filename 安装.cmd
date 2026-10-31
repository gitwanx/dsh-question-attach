@echo off
chcp 65001 >nul
setlocal
set "NODE="
where node >nul 2>nul && set "NODE=node"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE (
  echo [x] Node.js not found. Install Node.js 18+ first.
  pause
  exit /b 1
)
"%NODE%" "%~dp0tools\qattach.mjs" install
echo.
pause
