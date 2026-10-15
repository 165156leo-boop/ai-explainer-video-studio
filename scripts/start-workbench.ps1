param(
  [int]$Port = 3001,
  [switch]$SkipBuild,
  [switch]$SkipInstall,
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# One-key launcher for the workbench.
#
# Always rebuilds before starting. A running "next start" that is later
# overwritten by "next build" keeps serving chunks that no longer exist on
# disk, which shows up as a blank page with dead buttons (see PROJECT.md).
# The server stays in the foreground; press Ctrl+C to stop it.
#
# Run this from a normal Windows terminal belonging to your own user account.
# Starting the app from a restricted/sandboxed shell leaves it unable to write
# the reference-image request directory, and image jobs then fail with EPERM.

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$appRoot = Join-Path $projectRoot "publicity-video-ai-workbench"

if (-not (Test-Path -LiteralPath (Join-Path $appRoot "package.json"))) {
  throw "Workbench source was not found at $appRoot"
}

# Returns the PIDs listening on a TCP port. Prefers the NetTCPIP cmdlet and
# falls back to parsing netstat, so the script also works where the module is
# unavailable or the shell is constrained.
function Get-PortOwnerProcessId {
  param([Parameter(Mandatory = $true)][int]$Port)

  $owners = @()
  try {
    if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
      $owners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
        Select-Object -ExpandProperty OwningProcess -Unique)
    }
  } catch {
    $owners = @()
  }
  if ($owners.Count -eq 0) {
    # Columns: Proto  Local Address  Foreign Address  State  PID
    $pattern = ":$Port\s+\S+\s+LISTENING\s+(\d+)"
    $owners = @(netstat.exe -ano |
      Select-String -Pattern $pattern |
      ForEach-Object { [int]$_.Matches[0].Groups[1].Value } |
      Sort-Object -Unique)
  }
  return @($owners | Where-Object { $_ -and $_ -ne $PID })
}

$listeners = @(Get-PortOwnerProcessId -Port $Port)
if ($listeners.Count -gt 0) {
  foreach ($ownerProcessId in $listeners) {
    Write-Host "Port $Port is held by process $ownerProcessId; stopping it first."
    Stop-Process -Id $ownerProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 1
  if (@(Get-PortOwnerProcessId -Port $Port).Count -gt 0) {
    throw "Port $Port is still in use. Close the process holding it and retry."
  }
}

Push-Location $appRoot
try {
  if (-not $SkipInstall) {
    Write-Host "Checking dependencies (npm install)..."
    & npm.cmd install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
  }

  if (-not $SkipBuild) {
    Write-Host "Building the workbench (this is what makes source changes take effect)..."
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "next build failed with exit code $LASTEXITCODE" }
  }

  if (@(Get-PortOwnerProcessId -Port 8012).Count -eq 0) {
    Write-Host "Note: the local Doubao provider is not listening on 127.0.0.1:8012."
    Write-Host "      Start it from the workbench media panel, or run npm start in doubao-native-provider."
  }

  $url = "http://localhost:$Port/"
  Write-Host ""
  Write-Host "Workbench is starting: $url"
  Write-Host "Press Ctrl+C in this window to stop it."
  Write-Host ""

  # Always use "localhost" in the browser: browser storage is per origin, so
  # localhost and 127.0.0.1 do NOT share the remembered project and drafts.
  if (-not $NoBrowser) {
    Start-Job -ScriptBlock {
      param($target)
      for ($attempt = 0; $attempt -lt 240; $attempt += 1) {
        try {
          if ((Invoke-WebRequest -Uri $target -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) {
            Start-Process $target
            return
          }
        } catch {
        }
        Start-Sleep -Milliseconds 500
      }
    } -ArgumentList $url | Out-Null
  }

  & npm.cmd run start -- --port $Port
  if ($LASTEXITCODE -ne 0) { throw "next start exited with code $LASTEXITCODE" }
}
finally {
  Pop-Location
}
