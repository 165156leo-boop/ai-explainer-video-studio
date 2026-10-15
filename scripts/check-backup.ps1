$ErrorActionPreference = "Stop"
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("workbench-backup-test-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $testRoot | Out-Null
try {
  foreach ($relative in @("scripts", "publicity-video-ai-workbench/data", "doubao-native-provider/src", "doubao-native-provider/node_modules/electron")) {
    New-Item -ItemType Directory -Path (Join-Path $testRoot $relative) -Force | Out-Null
  }
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot "backup-workbench.ps1") -Destination (Join-Path $testRoot "scripts")
  Set-Content -LiteralPath (Join-Path $testRoot "PROJECT.md") -Value "fixture"
  Set-Content -LiteralPath (Join-Path $testRoot "publicity-video-ai-workbench/data/workbench-data.json") -Value '{"projects":[{"id":"fixture"}]}'
  Set-Content -LiteralPath (Join-Path $testRoot "doubao-native-provider/src/main.cjs") -Value "fixture"
  Set-Content -LiteralPath (Join-Path $testRoot "doubao-native-provider/package-lock.json") -Value "{}"
  Set-Content -LiteralPath (Join-Path $testRoot "doubao-native-provider/node_modules/electron/excluded.txt") -Value "fixture"
  Set-Content -LiteralPath (Join-Path $testRoot "doubao-native-provider/.env.local") -Value "fixture"
  $result = & (Join-Path $testRoot "scripts/backup-workbench.ps1") -Label regression
  $entries = tar.exe -tf $result.Archive
  if ($LASTEXITCODE -ne 0) { throw "Cannot read test archive" }
  if ($entries -match 'node_modules|\.env') { throw "Dependencies or environment files entered backup" }
  foreach ($required in @("doubao-native-provider/src/main.cjs", "doubao-native-provider/package-lock.json")) {
    if (-not ($entries -match [regex]::Escape($required))) { throw "Missing $required" }
  }
  Write-Output "Backup exclusion regression passed"
} finally {
  $resolved = [IO.Path]::GetFullPath($testRoot)
  $temporary = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if ([IO.Path]::GetDirectoryName($resolved).TrimEnd('\') -eq $temporary.TrimEnd('\') -and [IO.Path]::GetFileName($resolved).StartsWith("workbench-backup-test-")) {
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
