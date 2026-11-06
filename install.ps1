# Fig2AE 0.4 - Windows install (run Install.cmd). Per user, no admin rights.
#  - Fig2AE for After Effects (hidden server + AEUX-style panel) -> %APPDATA%\Adobe\CEP\extensions\fig2ae
#  - PlayerDebugMode=1 for CSXS 9..16 (unsigned extensions)
#  - fallback ScriptUI panel (Window > Fig2AE.jsx) into every After Effects version
#  - the Figma plugin -> %LOCALAPPDATA%\Fig2AE\figma-plugin (same place as the old Fig2AE-Setup.exe)
#  - %APPDATA%\Fig2AE\install.json: where things are, for auto-update
$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $MyInvocation.MyCommand.Path

if (Get-Process AfterFX -ErrorAction SilentlyContinue) {
  Write-Host "After Effects is running. Close it and run Install.cmd again." -ForegroundColor Yellow
  exit 1
}

$cep = Join-Path $env:APPDATA 'Adobe\CEP\extensions\fig2ae'
if (Test-Path $cep) { Remove-Item $cep -Recurse -Force }
Copy-Item (Join-Path $src 'cep') $cep -Recurse
Write-Host "After Effects extension -> $cep"

foreach ($v in 9..16) {
  $key = "HKCU:\Software\Adobe\CSXS.$v"
  if (-not (Test-Path $key)) { New-Item $key -Force | Out-Null }
  $cur = (Get-ItemProperty $key -Name PlayerDebugMode -ErrorAction SilentlyContinue).PlayerDebugMode
  if ($cur -ne '1') { Set-ItemProperty $key -Name PlayerDebugMode -Value '1' -Type String }
}
Write-Host "PlayerDebugMode = 1 (CSXS 9-16)"

$aeBase = Join-Path $env:APPDATA 'Adobe\After Effects'
if (Test-Path $aeBase) {
  Get-ChildItem $aeBase -Directory | Where-Object { $_.Name -match '^\d+(\.\d+)?$' } | ForEach-Object {
    $panels = Join-Path $_.FullName 'Scripts\ScriptUI Panels'
    New-Item $panels -ItemType Directory -Force | Out-Null
    Copy-Item (Join-Path $src 'ae\Fig2AE Panel.jsx') (Join-Path $panels 'Fig2AE.jsx') -Force
    $old = Join-Path $_.FullName 'Scripts\Startup\Fig2AE Startup.jsx'
    if (Test-Path $old) { Remove-Item $old -Force }
    Write-Host ("After Effects " + $_.Name + ": fallback panel Window > Fig2AE.jsx")
  }
}

# the Figma plugin lives in one fixed place, so auto-update can refresh it
$plugin = Join-Path $env:LOCALAPPDATA 'Fig2AE\figma-plugin'
if (Test-Path $plugin) { Remove-Item (Join-Path $plugin '*') -Recurse -Force } else { New-Item $plugin -ItemType Directory -Force | Out-Null }
Copy-Item (Join-Path $src 'figma-plugin\*') $plugin -Recurse -Force
$manifest = Join-Path $plugin 'manifest.json'
Write-Host "Figma plugin -> $plugin"

$cfg = Join-Path $env:APPDATA 'Fig2AE'
New-Item $cfg -ItemType Directory -Force | Out-Null
@{ figmaPlugin = $plugin; cep = $cep } | ConvertTo-Json | Set-Content -Path (Join-Path $cfg 'install.json') -Encoding UTF8
Remove-Item (Join-Path $cfg 'update.json') -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "1. Start After Effects: Window > Extensions > Fig2AE opens the panel."
Write-Host "   Once: Edit > Preferences > Scripting & Expressions > 'Allow Scripts to Write Files and Access Network'."
Write-Host "2. Figma desktop: if Fig2AE is not imported from this path yet - Plugins > Development > Import plugin from manifest..."
Write-Host "   $manifest"
Set-Clipboard -Value $manifest -ErrorAction SilentlyContinue
Write-Host "   (path copied to the clipboard)"
