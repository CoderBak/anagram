# Windows-only: an uninstall stopped partway by a file in use is finished by running the
# maintenance worker again from a terminal. No registry is touched: the component here is
# already in the state an uninstall leaves once the registrations are removed.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
if ($env:OS -ne 'Windows_NT') { throw 'This removal check requires Windows.' }
$root = Split-Path -Parent $PSScriptRoot
function Check([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message } }
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('anagram-uninstall-' + [Guid]::NewGuid().ToString('N'))
$component = Join-Path $temporary 'component with spaces'
$held = $null
try {
  foreach ($directory in @('app','models\fp32','venv\Scripts','bin')) { $null = New-Item -ItemType Directory -Path (Join-Path $component $directory) -Force }
  Set-Content -LiteralPath (Join-Path $component '.anagram-home') -Value 'owned fixture'
  $marker = @{schema_version=1;host='dev.coderbak.anagram';home=[IO.Path]::GetFullPath($component).TrimEnd('\')} | ConvertTo-Json
  [IO.File]::WriteAllText((Join-Path $component '.native-uninstall.json'),$marker,[Text.UTF8Encoding]::new($false))
  Copy-Item -LiteralPath (Join-Path $root 'installer\maintenance.ps1') -Destination (Join-Path $component 'app\maintenance.ps1')
  [IO.File]::WriteAllText((Join-Path $component 'app\native_host.py'),'# fixture')
  $model = Join-Path $component 'models\fp32\model.onnx'
  [IO.File]::WriteAllText($model,'weights')
  $worker = Join-Path $component 'app\maintenance.ps1'
  $run = { & $powershell -NoProfile -ExecutionPolicy Bypass -File $worker -Operation uninstall -ComponentHome $component 2>&1 | Out-String }

  # A file in use, as a model held open by a scanner: the removal stops, and says how to finish.
  $held = [IO.File]::Open($model,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  $output = & $run
  Check ($LASTEXITCODE -ne 0) "An uninstall that could not remove a file reported success: $output"
  Check ($output -match [regex]::Escape("-File `"$worker`" -Operation uninstall")) "The failed removal did not say how to finish it: $output"
  foreach ($kept in @('.anagram-home','.native-uninstall.json','app\maintenance.ps1')) {
    Check (Test-Path -LiteralPath (Join-Path $component $kept)) "The interrupted removal lost $kept, which finishing it needs"
  }
  $held.Dispose(); $held = $null

  # Run again, from a terminal: the rest goes, the folder with it.
  $output = & $run
  Check ($LASTEXITCODE -eq 0) "Finishing the removal failed: $output"
  Check (-not (Test-Path -LiteralPath $component)) "The finished removal left the folder behind: $output"

  # A folder that only looks like one is not removed: the marker must name this folder.
  $null = New-Item -ItemType Directory -Path (Join-Path $component 'app') -Force
  Set-Content -LiteralPath (Join-Path $component '.anagram-home') -Value 'owned fixture'
  [IO.File]::WriteAllText((Join-Path $component '.native-uninstall.json'),(@{schema_version=1;host='dev.coderbak.anagram';home='C:\elsewhere'} | ConvertTo-Json))
  Copy-Item -LiteralPath (Join-Path $root 'installer\maintenance.ps1') -Destination $worker
  $output = & $run
  Check ($LASTEXITCODE -ne 0 -and (Test-Path -LiteralPath (Join-Path $component '.anagram-home'))) "A marker naming another folder was accepted: $output"
  Write-Host 'PASS an uninstall stopped by a file in use keeps what finishing needs, says how, and finishes from a terminal; a foreign marker is refused'
} finally {
  if ($held) { $held.Dispose() }
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force -Recurse }
}
