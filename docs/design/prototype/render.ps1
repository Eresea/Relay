# Renders every prototype page under src/ to png/ with headless Edge.
# Usage: powershell -File render.ps1 [name-filter]
param([string]$Filter = "")
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $root "png"
New-Item -ItemType Directory -Force $out | Out-Null
Get-ChildItem (Join-Path $root "src") -Filter "*.html" | Where-Object { $_.Name -like "*$Filter*" } | ForEach-Object {
  $size = "1440,900"
  if ($_.Name -match 'size=(\d+x\d+)') { $size = $Matches[1] -replace 'x', ',' }
  $html = Get-Content $_.FullName -Raw
  if ($html -match '<meta name="size" content="(\d+),(\d+)">') { $size = "$($Matches[1]),$($Matches[2])" }
  $png = Join-Path $out ($_.BaseName + ".png")
  $uri = "file:///" + ($_.FullName -replace '\\', '/')
  $profile = Join-Path $env:TEMP "relay-proto-edge"
  & $edge --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files --force-device-scale-factor=2 `
    --user-data-dir="$profile" --virtual-time-budget=4000 --window-size=$size --screenshot="$png" $uri 2>$null | Out-Null
  Write-Host ("{0,-28} {1}" -f $_.Name, $size)
}
