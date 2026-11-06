# Fig2AE - remove the After Effects parts (the folder itself you can just delete)
$cep = Join-Path $env:APPDATA 'Adobe\CEP\extensions\fig2ae'
if (Test-Path $cep) { Remove-Item $cep -Recurse -Force; Write-Host "removed $cep" }
$aeBase = Join-Path $env:APPDATA 'Adobe\After Effects'
if (Test-Path $aeBase) {
  Get-ChildItem $aeBase -Directory | ForEach-Object {
    $p = Join-Path $_.FullName 'Scripts\ScriptUI Panels\Fig2AE.jsx'
    if (Test-Path $p) { Remove-Item $p -Force; Write-Host "removed $p" }
  }
}
Write-Host "In Figma remove the plugin: Plugins > Development > Manage plugins in development."
