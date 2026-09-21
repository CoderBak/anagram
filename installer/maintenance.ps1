# Fixed Windows maintenance worker. Only launched from the installed trusted helper.
param(
  [Parameter(Mandatory=$true)][ValidateSet('update','uninstall')][string]$Operation,
  [Parameter(Mandatory=$true)][string]$ComponentHome,
  [Parameter(Mandatory=$true)][int]$HostPid,
  [Parameter(Mandatory=$true)][string]$Receipt,
  [ValidateSet('en','zh_CN')][string]$Language = 'en'
)
$ErrorActionPreference = 'Stop'
function Say([string]$En,[string]$Zh) { if ($Language -eq 'zh_CN') { Write-Host $Zh } else { Write-Host $En } }
function Save-Receipt([string]$Path,$Value) { [IO.File]::WriteAllText($Path,($Value | ConvertTo-Json),[Text.UTF8Encoding]::new($false)) }
function Check-Home {
  $canonical = [IO.Path]::GetFullPath($ComponentHome).TrimEnd('\')
  if ($canonical -eq [IO.Path]::GetPathRoot($canonical).TrimEnd('\') -or $canonical -eq $env:USERPROFILE) { throw 'Unsafe component home' }
  $item = Get-Item -LiteralPath $canonical -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Component home is a reparse point' }
  $marker = Get-Content -LiteralPath (Join-Path $canonical '.native-component.json') -Encoding UTF8 -Raw | ConvertFrom-Json
  if ($marker.schema_version -ne 1 -or $marker.host -ne 'dev.coderbak.anagram' -or $marker.home -ne $canonical) { throw 'Component ownership marker mismatch' }
  if (-not (Test-Path -LiteralPath (Join-Path $canonical '.anagram-home') -PathType Leaf)) { throw 'Component ownership marker missing' }
  return $canonical
}
try {
  Say 'Waiting for the browser component to stop…' '正在等待浏览器本地组件退出…'
  $process = Get-Process -Id $HostPid -ErrorAction SilentlyContinue
  if ($process -and -not $process.WaitForExit(60000)) { throw 'Browser component did not stop. Close Anagram setup and retry.' }
  # The launcher may exit milliseconds after Python; bounded wait avoids an EXE lock race.
  Start-Sleep -Milliseconds 500
  $ComponentHome = Check-Home
  $python = Join-Path $ComponentHome 'venv\Scripts\python.exe'
  $helper = Join-Path $ComponentHome 'app\native_registration.py'
  if ($Operation -eq 'update') {
    Say 'Updating the local component…' '正在更新本地组件…'
    & $python -I $helper update --home $ComponentHome --worker
    if ($LASTEXITCODE -ne 0) { throw 'Component update failed' }
  } else {
    Say 'Removing owned browser registrations and component files…' '正在移除属于 Anagram 的浏览器注册和组件文件…'
    & $python -I $helper unregister --home $ComponentHome
    if ($LASTEXITCODE -ne 0) { throw 'Native registration cleanup failed; component files were kept' }
    $null = Check-Home
    foreach ($item in Get-ChildItem -LiteralPath $ComponentHome -Force -Recurse) {
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing reparse point: $($item.FullName)" }
    }
    Remove-Item -LiteralPath $ComponentHome -Recurse -Force
  }
  $result = @{schema_version=1;operation=$Operation;status='completed';time=[DateTime]::UtcNow.ToString('o')}
  Save-Receipt $Receipt $result
  if ($Operation -eq 'update') {
    Save-Receipt (Join-Path $ComponentHome 'run\maintenance-receipt.json') $result
    Say 'Update complete. Return to Anagram and reconnect.' '更新完成。请返回 Anagram 并重新连接。'
  } else {
    Say 'Local component removed. You can now remove the Anagram browser extension.' '本地组件已移除。现在可以移除 Anagram 浏览器扩展。'
  }
} catch {
  Save-Receipt $Receipt @{schema_version=1;operation=$Operation;status='failed';error=$_.Exception.Message}
  Write-Host $_.Exception.Message -ForegroundColor Red
  Say 'Maintenance failed. Files may remain; see the message above.' '操作失败，可能仍有文件保留。请查看上方提示。'
} finally {
  Say 'Press Enter to close this window.' '按 Enter 关闭此窗口。'
  $null = Read-Host
}
