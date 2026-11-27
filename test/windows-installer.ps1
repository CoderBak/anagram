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
$names = @('Assert-Plain','Enter-InstallLock','Assert-InstallTargets','Undo-Install','Read-InstallState','Save-InstallState','Backup-Path','Move-Entry','Publish-Item','Keep-Entry','Remove-Empty','Hash','Say','Test-ReceiptName','Read-SealedFiles','Prune-MatchingFiles')
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
$MaintenanceLock = $null; $held = $null; $other = $null; $Language = 'en'
try {
  $null = New-Item -ItemType Directory -Path (Join-Path $ComponentHome 'bin') -Force
  Set-Content -LiteralPath (Join-Path $ComponentHome '.anagram-home') -Value "Anagram installation: $ComponentHome"
  $outside = Join-Path $temporary 'outside.txt'
  $source = Join-Path $temporary 'new-version.txt'
  [IO.File]::WriteAllText($outside,'untouched')
  [IO.File]::WriteAllText($source,'new-version')
  $version = Join-Path $ComponentHome 'VERSION'
  $null = New-Item -ItemType HardLink -Path $version -Value $outside
  $stagedVersion = Join-Path $ComponentHome 'staged-version'
  [IO.File]::Copy($source,$stagedVersion)
  Move-Entry $version (Join-Path $ComponentHome 'prior-version')
  Move-Entry $stagedVersion $version
  Check ([IO.File]::ReadAllText($outside) -eq 'untouched') 'Replacement overwrote an outside hardlink target'
  Check ([IO.File]::ReadAllText($version) -eq 'new-version') 'Replacement did not install the new file'
  Rejected { Move-Entry $version $outside }
  Write-Host 'PASS owned atomic replacement preserves outside hardlink target and refuses outside paths'

  $outsideDirectory = Join-Path $temporary 'outside-directory'
  $null = New-Item -ItemType Directory -Path $outsideDirectory
  [IO.File]::WriteAllText((Join-Path $outsideDirectory 'keep.txt'),'keep')
  $junction = Join-Path $ComponentHome 'bin\uv.exe.new'
  $null = New-Item -ItemType Junction -Path $junction -Value $outsideDirectory
  Rejected { Assert-InstallTargets }
  Rejected { Move-Entry $junction (Join-Path $ComponentHome 'moved-junction') }
  Check ([IO.File]::ReadAllText((Join-Path $outsideDirectory 'keep.txt')) -eq 'keep') 'Reparse target was changed'
  [IO.Directory]::Delete($junction)
  Write-Host 'PASS a reparse-point destination is refused without changing its target'

  $staging = Join-Path $ComponentHome 'venv.next'
  $null = New-Item -ItemType Directory -Path $staging
  [IO.File]::WriteAllText((Join-Path $staging 'recover.txt'),'previous transaction')
  Rejected { Assert-InstallTargets }
  Check ([IO.File]::ReadAllText((Join-Path $staging 'recover.txt')) -eq 'previous transaction') 'Pre-existing staging was removed'
  Check (-not (Test-Path -LiteralPath (Join-Path $ComponentHome '.native-host.lock'))) 'Staging rejection happened after installation began'
  Remove-Item -LiteralPath $staging -Recurse -Force
  Write-Host 'PASS installer preflight rejects pre-existing staging before fetching or deleting anything'

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

  $id = [Guid]::NewGuid().ToString('N')
  $state = @{schema=1; home=$ComponentHome; id=$id; phase='building'; operations=@(); work=@(); recoveryHash=''; filesHash=''; bootstrapHash=''; basePython=''; newDirs=@(); freshMarker=$false; freshHome=$false; freshLock=$false; browser='chrome'; extensionId=('a'*32); language='en'}
  $workspace = (New-Item -ItemType Directory -Path (Join-Path $ComponentHome ('.install-' + $id))).FullName
  $staged = (New-Item -ItemType Directory -Path (Join-Path $workspace 'next-app')).FullName
  [IO.File]::WriteAllText((Join-Path $staged 'program.py'),'new program')
  $app = (New-Item -ItemType Directory -Path (Join-Path $ComponentHome 'app')).FullName
  [IO.File]::WriteAllText((Join-Path $app 'prior.txt'),'old app')
  $newVersion = Join-Path $workspace 'next-version'
  [IO.File]::WriteAllText($newVersion,'upgraded version')
  $receipt = @{schema_version=1;home=$ComponentHome;files=@{app='dir';'app/program.py'=(Hash (Join-Path $staged 'program.py'));VERSION=(Hash $newVersion)}}
  [IO.File]::WriteAllText((Join-Path $workspace 'files.json'),($receipt | ConvertTo-Json))
  $state.filesHash = Hash (Join-Path $workspace 'files.json')
  Save-InstallState $state
  Publish-Item 'app' $staged
  Publish-Item 'VERSION' $newVersion
  [IO.File]::WriteAllText((Join-Path $app 'notes.txt'),'user notes')
  # Read the journal afresh, as a new installer would after loss of power.
  Undo-Install (Read-InstallState)
  Check ([IO.File]::ReadAllText($version) -eq 'new-version') 'Previous version was not restored'
  Check ([IO.File]::ReadAllText((Join-Path $app 'prior.txt')) -eq 'old app') 'Previous application was not restored'
  $preserved = @(Get-ChildItem -LiteralPath $ComponentHome -Directory -Force | Where-Object { $_.Name.StartsWith('.preserved-') })
  Check ($preserved.Count -eq 1) 'Expected preserved edits'
  Check ([IO.File]::ReadAllText((Join-Path $preserved[0].FullName 'app\notes.txt')) -eq 'user notes') 'Recovery lost user additions'
  Check (-not (Test-Path -LiteralPath (Join-Path $preserved[0].FullName 'app\program.py'))) 'Recovery retained unchanged new program'
  Undo-Install (Read-InstallState)
  Check ([IO.File]::ReadAllText((Join-Path $app 'prior.txt')) -eq 'old app') 'Repeated recovery modified the restored application'
  Check ([IO.File]::ReadAllText($outside) -eq 'untouched') 'Rollback touched the unrelated file'
  Write-Host 'PASS crash recovery restores previous files, keeps user additions and tolerates a repeat'
} finally {
  if ($held) { $held.Dispose() }
  if ($other) { $other.Dispose() }
  if ($MaintenanceLock) { $MaintenanceLock.Dispose() }
  # All fixtures, including the simulated outside target, are under this temp root.
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
}
