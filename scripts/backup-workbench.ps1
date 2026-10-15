param(
  [string]$Label = "checkpoint"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$backupRoot = Join-Path $projectRoot "backups"
$safeLabel = ($Label -replace "[^A-Za-z0-9_-]", "-").Trim("-")
if (-not $safeLabel) { $safeLabel = "checkpoint" }
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$archive = Join-Path $backupRoot "ai-video-workbench-$stamp-$safeLabel.zip"
$stage = Join-Path ([IO.Path]::GetTempPath()) "ai-video-workbench-$stamp"

New-Item -ItemType Directory -Path $backupRoot, $stage -Force | Out-Null

try {
  foreach ($file in Get-ChildItem -LiteralPath $projectRoot -File -Filter "*.md") {
    Copy-Item -LiteralPath $file.FullName -Destination $stage
  }

  Copy-Item -LiteralPath (Join-Path $projectRoot "scripts") -Destination $stage -Recurse
  $rootDirectories = Get-ChildItem -LiteralPath $projectRoot -Directory |
    Where-Object { $_.Name -notin @("publicity-video-ai-workbench", "scripts", "backups", "restore-previews") }
  foreach ($directory in $rootDirectories) {
    $directoryTarget = Join-Path $stage $directory.Name
    & robocopy $directory.FullName $directoryTarget /E /XD node_modules .next __pycache__ .git /XF .env .env.* /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -gt 7) { throw "Directory copy failed: $($directory.Name). robocopy code: $LASTEXITCODE" }
  }

  $appSource = Join-Path $projectRoot "publicity-video-ai-workbench"
  $appTarget = Join-Path $stage "publicity-video-ai-workbench"
  & robocopy $appSource $appTarget /E /XD node_modules .next /XF .env .env.* /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -gt 7) { throw "Workbench copy failed. robocopy code: $LASTEXITCODE" }

  $dataPath = Join-Path $appSource "data\workbench-data.json"
  $dataRaw = [IO.File]::ReadAllText($dataPath, [Text.Encoding]::UTF8)
  $data = $dataRaw | ConvertFrom-Json
  if (-not $data.projects -or $data.projects.Count -lt 1) {
    throw "Workspace data is empty. Backup aborted."
  }
  [IO.File]::WriteAllText(
    (Join-Path $appTarget "data\workbench-data.json"),
    $dataRaw,
    [Text.UTF8Encoding]::new($false)
  )

  tar.exe -a -cf $archive -C $stage .
  if ($LASTEXITCODE -ne 0) { throw "Archive creation failed." }

  $entries = tar.exe -tf $archive
  if (-not ($entries -match "publicity-video-ai-workbench/data/workbench-data.json")) {
    throw "Archive is missing workspace data."
  }
  if (-not ($entries -match "PROJECT.md")) { throw "Archive is missing PROJECT.md." }

  $hash = Get-FileHash -LiteralPath $archive -Algorithm SHA256
  "$($hash.Hash)  $([IO.Path]::GetFileName($archive))" |
    Set-Content -LiteralPath "$archive.sha256" -Encoding ascii

  [pscustomobject]@{
    Archive = $archive
    SizeMB = [Math]::Round((Get-Item -LiteralPath $archive).Length / 1MB, 1)
    SHA256 = $hash.Hash
    Projects = $data.projects.Count
  }
}
finally {
  $resolvedStage = [IO.Path]::GetFullPath($stage)
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if ($resolvedStage.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $resolvedStage -Recurse -Force -ErrorAction SilentlyContinue
  }
}
