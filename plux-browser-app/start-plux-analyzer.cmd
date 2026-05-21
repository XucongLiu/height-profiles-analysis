@echo off
setlocal
cd /d "%~dp0"
echo Starting PLUX Surface Analyzer...
echo.
echo Open this address in your browser:
echo http://127.0.0.1:4173
echo.
echo Keep this window open while using the app. Press Ctrl+C to stop.
echo.
npx http-server -p 4173 -a 127.0.0.1
pause
