$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $projectRoot 'plugins\team-workspace-probe'
$marketplacePath = Join-Path $env:USERPROFILE '.agents\plugins\marketplace.json'
$destination = Join-Path $env:USERPROFILE '.agents\plugins\team-workspace-probe'
$evidence = Join-Path $projectRoot 'evidence\registration'
if (Test-Path -LiteralPath $destination) {
  $sourceFiles = @(Get-ChildItem -LiteralPath $source -File -Recurse)
  $targetFiles = @(Get-ChildItem -LiteralPath $destination -File -Recurse)
  if ($sourceFiles.Count -ne $targetFiles.Count) { throw 'Existing probe differs; refusing overwrite.' }
  foreach ($file in $sourceFiles) {
    $relative = [IO.Path]::GetRelativePath($source, $file.FullName)
    $targetFile = Join-Path $destination $relative
    if (!(Test-Path -LiteralPath $targetFile) -or
        (Get-FileHash -LiteralPath $file.FullName).Hash -ne (Get-FileHash -LiteralPath $targetFile).Hash) {
      throw 'Existing probe differs; refusing overwrite.'
    }
  }
}
if (!(Test-Path -LiteralPath (Join-Path $source 'dist\server.cjs'))) { throw 'Build the probe first.' }
$raw = [IO.File]::ReadAllText($marketplacePath)
$catalog = $raw | ConvertFrom-Json
if (@($catalog.plugins | Where-Object name -eq 'team-workspace-probe').Count -ne 0) { throw 'Probe already registered.' }
$beforeHash = (Get-FileHash -LiteralPath $marketplacePath -Algorithm SHA256).Hash
$configPath = Join-Path $env:USERPROFILE '.codex\config.toml'
$configHash = (Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash
New-Item -ItemType Directory -Path $evidence -Force | Out-Null
$stamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$backupPath = Join-Path $evidence "marketplace-before-$stamp.json"
Copy-Item -LiteralPath $marketplacePath -Destination $backupPath
if (!(Test-Path -LiteralPath $destination)) { Copy-Item -LiteralPath $source -Destination $destination -Recurse }
$catalog.plugins = @($catalog.plugins) + @([pscustomobject]@{
  name='team-workspace-probe'
  source=[pscustomobject]@{source='local';path='./.agents/plugins/team-workspace-probe'}
  policy=[pscustomobject]@{installation='AVAILABLE';authentication='ON_INSTALL'}
  category='Developer Tools'
})
if ((Get-FileHash -LiteralPath $marketplacePath -Algorithm SHA256).Hash -ne $beforeHash) {
  throw 'Marketplace changed concurrently; refusing to overwrite. Copied probe remains unregistered.'
}
$serialized = $catalog | ConvertTo-Json -Depth 30
$tempCatalog = "$marketplacePath.team-workspace-$stamp.tmp"
[IO.File]::WriteAllText($tempCatalog, $serialized, [Text.UTF8Encoding]::new($false))
[IO.File]::Move($tempCatalog, $marketplacePath, $true)
$after = Get-Content -LiteralPath $marketplacePath -Raw | ConvertFrom-Json
$before = $raw | ConvertFrom-Json
foreach($old in $before.plugins) {
  $new = @($after.plugins | Where-Object name -eq $old.name)
  if ($new.Count -ne 1 -or (($new[0] | ConvertTo-Json -Depth 30 -Compress) -ne ($old | ConvertTo-Json -Depth 30 -Compress))) {
    throw 'Existing entry preservation check failed. Inspect backup and current catalog.'
  }
}
$record = [pscustomobject]@{
  observedAt=[DateTimeOffset]::UtcNow.ToString('o'); status='REGISTERED_NOT_INSTALLED'
  marketplace=$marketplacePath; pluginSource=$destination; backup=$backupPath
  marketplaceBeforeSHA256=$beforeHash
  marketplaceAfterSHA256=(Get-FileHash -LiteralPath $marketplacePath -Algorithm SHA256).Hash
  configBeforeSHA256=$configHash
  configAfterSHA256=(Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash
  existingEntriesPreserved=$true; modelCalls=0; businessTeamsStarted=0
}
$record | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $evidence 'result.json') -Encoding utf8
$record | ConvertTo-Json -Depth 5
