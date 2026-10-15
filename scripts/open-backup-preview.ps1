param(
  [Parameter(Mandatory = $true)]
  [string]$Archive
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$backupRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot "backups"))
$archivePath = [IO.Path]::GetFullPath((Resolve-Path $Archive).Path)
if (-not $archivePath.StartsWith($backupRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Only archives inside this project's backups directory can be previewed."
}

$previewRoot = Join-Path $projectRoot "restore-previews"
$destination = Join-Path $previewRoot ([IO.Path]::GetFileNameWithoutExtension($archivePath))
if (Test-Path -LiteralPath $destination) {
  throw "Preview directory already exists: $destination"
}

New-Item -ItemType Directory -Path $destination -Force | Out-Null
Expand-Archive -LiteralPath $archivePath -DestinationPath $destination

$dataPath = Join-Path $destination "publicity-video-ai-workbench\data\workbench-data.json"
$data = Get-Content -LiteralPath $dataPath -Raw -Encoding utf8 | ConvertFrom-Json
if (-not (Test-Path -LiteralPath (Join-Path $destination "PROJECT.md"))) {
  throw "Backup preview is missing PROJECT.md."
}

[pscustomobject]@{
  Preview = $destination
  Projects = $data.projects.Count
  CreatedFrom = $archivePath
  Safe = "Preview only; the current project was not overwritten."
}
