# Windows-only functional safety checks. No downloads, real component or registry.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
if ($env:OS -ne 'Windows_NT') { throw 'These filesystem/byte-lock checks require Windows.' }
$root = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $root 'install.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($installer,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
# Load the actual production helpers without running its installer entrypoint.
$names = @('Assert-Plain','Assert-OwnedTree','Remove-OwnedTree','Install-OwnedFile','Enter-InstallLock','Assert-InstallTargets','Undo-Install')
foreach ($definition in $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$true)) {
  if ($names -contains $definition.Name) { . ([scriptblock]::Create($definition.Extent.Text)) }
}
function Check([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message } }
function Rejected([scriptblock]$Action) {
  $failed = $false
  try { $null = & $Action } catch { $failed = $true }
  Check $failed 'Unsafe operation was not rejected'
}
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('anagram-installer-safety-' + [Guid]::NewGuid().ToString('N'))
$ComponentHome = Join-Path $temporary 'component'
$MaintenanceLock = $null; $held = $null; $other = $null
try {
  $null = New-Item -ItemType Directory -Path (Join-Path $ComponentHome 'bin') -Force
  Set-Content -LiteralPath (Join-Path $ComponentHome '.anagram-home') -Value 'owned fixture'
  $outside = Join-Path $temporary 'outside.txt'
  $source = Join-Path $temporary 'new-version.txt'
  [IO.File]::WriteAllText($outside,'untouched')
  [IO.File]::WriteAllText($source,'new-version')
  $version = Join-Path $ComponentHome 'VERSION'
  $null = New-Item -ItemType HardLink -Path $version -Value $outside
  Install-OwnedFile $source $version
  Check ([IO.File]::ReadAllText($outside) -eq 'untouched') 'Replacement overwrote an outside hardlink target'
  Check ([IO.File]::ReadAllText($version) -eq 'new-version') 'Replacement did not install the new file'
  Rejected { Install-OwnedFile $source $outside }
  Write-Host 'PASS owned atomic replacement preserves outside hardlink target and refuses outside paths'

  $outsideDirectory = Join-Path $temporary 'outside-directory'
  $null = New-Item -ItemType Directory -Path $outsideDirectory
  [IO.File]::WriteAllText((Join-Path $outsideDirectory 'keep.txt'),'keep')
  $junction = Join-Path $ComponentHome 'bin\uv.exe.new'
  $null = New-Item -ItemType Junction -Path $junction -Value $outsideDirectory
  Rejected { Assert-InstallTargets }
  Rejected { Install-OwnedFile $source $junction }
  Rejected { Remove-OwnedTree (Join-Path $ComponentHome 'bin') }
  Check ([IO.File]::ReadAllText((Join-Path $outsideDirectory 'keep.txt')) -eq 'keep') 'Reparse target was changed'
  [IO.Directory]::Delete($junction)
  Write-Host 'PASS reparse leaf and nested recursive deletion are refused without touching their target'

  $staging = Join-Path $ComponentHome 'venv.next'
  $null = New-Item -ItemType Directory -Path $staging
  [IO.File]::WriteAllText((Join-Path $staging 'recover.txt'),'previous transaction')
  Rejected { & $installer -ComponentHome $ComponentHome -Browser chrome -ExtensionId ('a' * 32) -ReleaseUrl 'file:///nonexistent-anagram-fixture' }
  Check ([IO.File]::ReadAllText((Join-Path $staging 'recover.txt')) -eq 'previous transaction') 'Pre-existing staging was removed'
  Check (-not (Test-Path -LiteralPath (Join-Path $ComponentHome '.native-host.lock'))) 'Staging rejection happened after installation began'
  Remove-Item -LiteralPath $staging -Recurse -Force
  Write-Host 'PASS full installer rejects pre-existing staging before fetching or deleting anything'

  $held = Enter-InstallLock
  Rejected { Enter-InstallLock }
  $MaintenanceLock = $held
  $borrowed = Enter-InstallLock
  Check ([object]::ReferenceEquals($held,$borrowed)) 'Maintenance did not borrow the original locked handle'
  $other = [IO.FileStream]::new((Join-Path $ComponentHome '.native-host.lock'),[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
  $MaintenanceLock = $other
  Rejected { Enter-InstallLock }
  $other.Dispose(); $other = $null
  $held.Dispose(); $held = $null
  $MaintenanceLock = [IO.FileStream]::new((Join-Path $ComponentHome '.native-host.lock'),[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
  Rejected { Enter-InstallLock }
  $MaintenanceLock.Dispose(); $MaintenanceLock = $null
  $held = Enter-InstallLock
  $held.Dispose(); $held = $null
  Write-Host 'PASS concurrent lock exclusion, same-handle handoff, wrong/unlocked stream rejection and release'

  $app = Join-Path $ComponentHome 'app'
  $launcher = Join-Path $ComponentHome 'bin\anagram-native.exe'
  $null = New-Item -ItemType Directory -Path $app
  $null = New-Item -ItemType Directory -Path $staging
  [IO.File]::WriteAllText($launcher,'new launcher')
  Undo-Install @($app) $true $true $true '' ''
  foreach ($path in @($app,$staging,$launcher,$version)) { Check (-not (Test-Path -LiteralPath $path)) "Fresh failure left $path" }

  $null = New-Item -ItemType Directory -Path ($app + '.old')
  [IO.File]::WriteAllText((Join-Path ($app + '.old') 'old.txt'),'old app')
  $null = New-Item -ItemType Directory -Path $app
  [IO.File]::WriteAllText($launcher,'new launcher')
  [IO.File]::WriteAllText($version,'new version')
  $backupLauncher = Join-Path $temporary 'launcher.backup'
  $backupVersion = Join-Path $temporary 'version.backup'
  [IO.File]::WriteAllText($backupLauncher,'old launcher')
  [IO.File]::WriteAllText($backupVersion,'old version')
  Undo-Install @($app) $false $true $true $backupLauncher $backupVersion
  Check ([IO.File]::ReadAllText($launcher) -eq 'old launcher') 'Launcher was not restored'
  Check ([IO.File]::ReadAllText($version) -eq 'old version') 'Version was not restored'
  Check ([IO.File]::ReadAllText((Join-Path $app 'old.txt')) -eq 'old app') 'Application was not restored'
  Check ([IO.File]::ReadAllText($outside) -eq 'untouched') 'Rollback touched the unrelated file'
  Write-Host 'PASS fresh failure removes created files and upgrade failure restores previous files'
} finally {
  if ($held) { $held.Dispose() }
  if ($other) { $other.Dispose() }
  if ($MaintenanceLock) { $MaintenanceLock.Dispose() }
  # All fixtures, including the simulated outside target, are under this temp root.
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
}
