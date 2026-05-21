@echo off
setlocal
cd /d "%~dp0"

where git >nul 2>nul
if %errorlevel% neq 0 (
  echo Git was not found. Install Git first, then run this file again.
  pause
  exit /b 1
)

where npx >nul 2>nul
if %errorlevel% neq 0 (
  echo npx was not found. Install Node.js first, then run this file again.
  pause
  exit /b 1
)

git pull --ff-only
cd /d "%~dp0plux-browser-app"
start "" http://127.0.0.1:4173
npx http-server -p 4173 -a 127.0.0.1
