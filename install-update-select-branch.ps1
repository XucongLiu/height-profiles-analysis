$ErrorActionPreference = "Stop"

$RepoUrl = "https://github.com/XucongLiu/height-profiles-analysis.git"
$DefaultInstallDir = Join-Path $env:USERPROFILE "height-profiles-analysis"
$Port = 4173

$Branches = @(
  @{ Key = "1"; Name = "main"; Description = "Stable release" },
  @{ Key = "2"; Name = "experiment/interpolate-fft-denoise"; Description = "Interpolation + FFT/CCA geometry branch" },
  @{ Key = "3"; Name = "experiment/edge-detection-polygons"; Description = "Gaussian edge detection + polygon fitting branch" }
)

function Test-Command($Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machine;$user"
}

function Install-WithWinget($Id, $DisplayName) {
  if (Test-Command $DisplayName.ToLower()) {
    return
  }
  if (-not (Test-Command "winget.exe")) {
    throw "$DisplayName is missing and winget is not available. Install $DisplayName manually, then run this script again."
  }
  $answer = Read-Host "$DisplayName is missing. Install it with winget now? [Y/n]"
  if ($answer -match "^[Nn]") {
    throw "$DisplayName is required."
  }
  winget install --id $Id --exact --source winget --accept-package-agreements --accept-source-agreements
  Refresh-Path
}

function Ensure-Prerequisites {
  if (-not (Test-Command "git.exe")) {
    Install-WithWinget "Git.Git" "Git"
  }
  if (-not (Test-Command "node.exe")) {
    Install-WithWinget "OpenJS.NodeJS.LTS" "Node"
  }
  if (-not (Test-Command "npx.cmd")) {
    Refresh-Path
  }
  if (-not (Test-Command "git.exe")) {
    throw "Git is still not available on PATH after installation."
  }
  if (-not (Test-Command "node.exe")) {
    throw "Node.js is still not available on PATH after installation."
  }
  if (-not (Test-Command "npx.cmd")) {
    throw "npx.cmd is still not available on PATH after installation."
  }
}

function Choose-InstallDir {
  Write-Host ""
  Write-Host "Default install/update folder:" -ForegroundColor Cyan
  Write-Host $DefaultInstallDir
  $custom = Read-Host "Press Enter to use this folder, or type another folder path"
  if ([string]::IsNullOrWhiteSpace($custom)) {
    return $DefaultInstallDir
  }
  return [Environment]::ExpandEnvironmentVariables($custom.Trim('"'))
}

function Ensure-Repository($InstallDir) {
  if (Test-Path $InstallDir) {
    if (-not (Test-Path (Join-Path $InstallDir ".git"))) {
      throw "The folder exists but is not a Git repository: $InstallDir"
    }
    Set-Location $InstallDir
    Write-Host "Updating existing repository..." -ForegroundColor Cyan
    git remote set-url origin $RepoUrl
    git fetch origin --prune
    return
  }

  $parent = Split-Path -Parent $InstallDir
  if ($parent -and -not (Test-Path $parent)) {
    New-Item -ItemType Directory -Path $parent | Out-Null
  }
  Write-Host "Cloning repository to $InstallDir..." -ForegroundColor Cyan
  git clone $RepoUrl $InstallDir
  Set-Location $InstallDir
  git fetch origin --prune
}

function Choose-Branch {
  Write-Host ""
  Write-Host "Choose which PLUX Surface Analyzer branch to run:" -ForegroundColor Cyan
  foreach ($branch in $Branches) {
    Write-Host "$($branch.Key). $($branch.Name) - $($branch.Description)"
  }
  Write-Host ""
  $choice = Read-Host "Choose branch [1-3]"
  $selected = $Branches | Where-Object { $_.Key -eq $choice } | Select-Object -First 1
  if (-not $selected) {
    throw "Invalid choice: $choice"
  }
  return $selected.Name
}

function Switch-ToBranch($BranchName) {
  Write-Host "Switching to $BranchName..." -ForegroundColor Cyan
  git fetch origin $BranchName
  git switch $BranchName 2>$null
  if ($LASTEXITCODE -ne 0) {
    git switch --track "origin/$BranchName"
  }
  git pull origin $BranchName
}

function Start-App {
  $appDir = Join-Path (Get-Location) "plux-browser-app"
  if (-not (Test-Path (Join-Path $appDir "index.html"))) {
    throw "Cannot find plux-browser-app in $(Get-Location)."
  }
  Set-Location $appDir
  $url = "http://127.0.0.1:$Port"
  Write-Host ""
  Write-Host "Starting PLUX Surface Analyzer at $url" -ForegroundColor Green
  Write-Host "A browser window should open. Press Ctrl+C here to stop the server."
  Write-Host ""
  Start-Process $url
  npx.cmd --yes http-server -p $Port -a 127.0.0.1
}

Write-Host ""
Write-Host "PLUX Surface Analyzer installer/updater/branch launcher" -ForegroundColor Cyan
Write-Host ""

Ensure-Prerequisites
$installDir = Choose-InstallDir
Ensure-Repository $installDir
$branch = Choose-Branch
Switch-ToBranch $branch
Start-App
