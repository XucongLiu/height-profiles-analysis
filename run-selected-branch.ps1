$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$branches = @(
  @{ Key = "1"; Name = "main"; Description = "Stable release" },
  @{ Key = "2"; Name = "experiment/interpolate-fft-denoise"; Description = "Interpolation + FFT/CCA geometry branch" },
  @{ Key = "3"; Name = "experiment/edge-detection-polygons"; Description = "Gaussian edge detection + polygon fitting branch" }
)

Write-Host ""
Write-Host "PLUX Surface Analyzer branch launcher" -ForegroundColor Cyan
Write-Host ""
foreach ($branch in $branches) {
  Write-Host "$($branch.Key). $($branch.Name) - $($branch.Description)"
}
Write-Host ""

$choice = Read-Host "Choose branch [1-3]"
$selected = $branches | Where-Object { $_.Key -eq $choice } | Select-Object -First 1
if (-not $selected) {
  throw "Invalid choice: $choice"
}

Set-Location $repo
Write-Host "Fetching latest branches..." -ForegroundColor Cyan
git fetch origin

Write-Host "Switching to $($selected.Name)..." -ForegroundColor Cyan
git switch $selected.Name
git pull origin $selected.Name

Set-Location (Join-Path $repo "plux-browser-app")
Write-Host ""
Write-Host "Starting server at http://127.0.0.1:4173" -ForegroundColor Green
Write-Host "Press Ctrl+C in this window to stop the server."
Write-Host ""

npx.cmd http-server -p 4173 -a 127.0.0.1
