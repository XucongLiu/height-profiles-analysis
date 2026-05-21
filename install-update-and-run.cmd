@echo off
setlocal

set "REPO_URL=https://github.com/XucongLiu/height-profiles-analysis.git"
set "INSTALL_DIR=%USERPROFILE%\height-profiles-analysis"
set "APP_URL=http://127.0.0.1:4173"

title PLUX Surface Analyzer
echo.
echo PLUX Surface Analyzer
echo =====================
echo.

where git >nul 2>nul
if %errorlevel% neq 0 (
  echo Git was not found on this computer.
  echo Please install Git for Windows from:
  echo https://git-scm.com/download/win
  echo.
  pause
  exit /b 1
)

where npx >nul 2>nul
if %errorlevel% neq 0 (
  echo Node.js / npx was not found on this computer.
  echo Please install Node.js LTS from:
  echo https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist "%INSTALL_DIR%\.git" (
  if exist "%INSTALL_DIR%" (
    echo The folder already exists, but it is not a Git repository:
    echo %INSTALL_DIR%
    echo.
    echo Please move or rename that folder, then run this file again.
    pause
    exit /b 1
  )
  echo Downloading the latest app from GitHub...
  git clone "%REPO_URL%" "%INSTALL_DIR%"
  if %errorlevel% neq 0 (
    echo.
    echo Download failed. Please check the internet connection and try again.
    pause
    exit /b 1
  )
) else (
  echo Updating the app to the latest version...
  cd /d "%INSTALL_DIR%"
  git pull --ff-only
  if %errorlevel% neq 0 (
    echo.
    echo Update failed. The existing app will not be started until this is fixed.
    pause
    exit /b 1
  )
)

cd /d "%INSTALL_DIR%\plux-browser-app"
echo.
echo Starting local app server...
echo Opening %APP_URL%
echo.
start "" "%APP_URL%"
npx --yes http-server@14.1.1 -p 4173 -a 127.0.0.1

echo.
echo Server stopped.
pause
