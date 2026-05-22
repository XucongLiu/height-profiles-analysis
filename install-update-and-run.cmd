@echo off
setlocal

set "REPO_URL=https://github.com/XucongLiu/height-profiles-analysis.git"
set "INSTALL_DIR=%USERPROFILE%\height-profiles-analysis"
set "APP_URL=http://127.0.0.1:4173"
set "CHECK_ONLY=0"
set "NO_SERVER=0"

if /I "%~1"=="--check" set "CHECK_ONLY=1"
if /I "%~1"=="--no-server" set "NO_SERVER=1"

title PLUX Surface Analyzer
echo.
echo PLUX Surface Analyzer
echo =====================
echo.

where git >nul 2>nul
if %errorlevel% neq 0 (
  echo Git was not found on this computer.
  echo Trying to install Git with winget...
  echo.
  where winget >nul 2>nul
  if %errorlevel% neq 0 (
    echo winget was not found, so Git cannot be installed automatically.
    echo Please install Git for Windows from:
    echo https://git-scm.com/download/win
    echo.
    pause
    exit /b 1
  )
  winget install --id Git.Git --exact --source winget --accept-source-agreements --accept-package-agreements
  if %errorlevel% neq 0 (
    echo.
    echo Git installation failed.
    echo Please install Git manually from:
    echo https://git-scm.com/download/win
    echo.
    pause
    exit /b 1
  )
  set "PATH=%PATH%;%ProgramFiles%\Git\cmd;%ProgramFiles(x86)%\Git\cmd"
  where git >nul 2>nul
  if %errorlevel% neq 0 (
    echo.
    echo Git was installed, but this command window cannot find it yet.
    echo Close this window and double-click this file again.
    pause
    exit /b 1
  )
)

where npx >nul 2>nul
if %errorlevel% neq 0 (
  echo Node.js / npx was not found on this computer.
  echo Trying to install Node.js LTS with winget...
  echo.
  where winget >nul 2>nul
  if %errorlevel% neq 0 (
    echo winget was not found, so Node.js cannot be installed automatically.
    echo Please install Node.js LTS from:
    echo https://nodejs.org/
    echo.
    pause
    exit /b 1
  )
  winget install --id OpenJS.NodeJS.LTS --exact --source winget --accept-source-agreements --accept-package-agreements
  if %errorlevel% neq 0 (
    echo.
    echo Node.js installation failed.
    echo Please install Node.js LTS manually from:
    echo https://nodejs.org/
    echo.
    pause
    exit /b 1
  )
  set "PATH=%PATH%;%ProgramFiles%\nodejs;%APPDATA%\npm"
  where npx >nul 2>nul
  if %errorlevel% neq 0 (
    echo.
    echo Node.js was installed, but this command window cannot find npx yet.
    echo Close this window and double-click this file again.
    pause
    exit /b 1
  )
)

if "%CHECK_ONLY%"=="1" (
  echo Prerequisite check passed.
  echo.
  git --version
  node --version
  npx --version
  echo.
  where winget >nul 2>nul
  if %errorlevel% equ 0 (
    echo winget is available for automatic prerequisite installation.
  ) else (
    echo winget is not available. Automatic prerequisite installation will not work.
  )
  echo.
  pause
  exit /b 0
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
if "%NO_SERVER%"=="1" (
  echo Clone/update test passed. Server start was skipped because --no-server was used.
  echo App folder:
  echo %CD%
  echo.
  exit /b 0
)

echo Starting local app server...
echo Opening %APP_URL%
echo.
start "" "%APP_URL%"
npx --yes http-server@14.1.1 -p 4173 -a 127.0.0.1

echo.
echo Server stopped.
pause
