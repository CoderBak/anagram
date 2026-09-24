# Anagram native component installer for Windows x64, Windows PowerShell 5.1+.
# Run the exact browser-specific command shown in Anagram setup. No admin, PATH,
# login startup, system Python, or HTTP server is required.
[CmdletBinding()]
param(
  [string]$ExtensionId = $env:ANAGRAM_EXTENSION_ID,
  [ValidateSet('chrome','firefox')][string]$Browser = $env:ANAGRAM_BROWSER,
  [ValidateSet('en','zh_CN')][string]$Language = $(if ($env:ANAGRAM_LANG) {$env:ANAGRAM_LANG} else {'en'}),
  [string]$ComponentHome = $(if ($env:ANAGRAM_HOME) {$env:ANAGRAM_HOME} else {Join-Path $env:LOCALAPPDATA 'Anagram'}),
  [string]$ReleaseUrl = $(if ($env:ANAGRAM_RELEASE_URL) {$env:ANAGRAM_RELEASE_URL} else {'https://github.com/CoderBak/anagram/releases/latest/download'}),
  # Only the fixed maintenance worker passes a live, already locked stream.
  [Parameter(DontShow=$true)][IO.FileStream]$MaintenanceLock
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$UvVersion = '0.11.18'
$UvHash = 'bf8e0021336b7c77bd80a078b612125f385b08f541437edaea8c8ca9e574db0d'
$PythonVersion = '3.12.13'
function Say([string]$En,[string]$Zh) { if ($Language -eq 'zh_CN') { Write-Host "==> $Zh" } else { Write-Host "==> $En" } }
function Assert-Plain([string]$Path,[string]$Boundary) {
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  $base = [IO.Path]::GetFullPath($Boundary).TrimEnd('\')
  if ($full -ne $base -and -not $full.StartsWith($base + '\',[StringComparison]::OrdinalIgnoreCase)) { throw "Path outside owned directory: $full" }
  $current = $full
  while ($current.Length -ge $base.Length) {
    # Get the entry itself, including a dangling link whose target fails Test-Path.
    $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Symbolic link/reparse point refused: $current" }
    if ($current -eq $base) { break }
    $current = Split-Path -Parent $current
  }
}
function Assert-OwnedTree([string]$Path) {
  Assert-Plain $Path $ComponentHome
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push($Path)
  while ($pending.Count -gt 0) {
    $item = Get-Item -LiteralPath ($pending.Pop()) -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing reparse point: $($item.FullName)" }
    if ($item.PSIsContainer) {
      foreach ($child in Get-ChildItem -LiteralPath $item.FullName -Force) { $pending.Push($child.FullName) }
    }
  }
}
function Remove-OwnedTree([string]$Path) {
  Assert-OwnedTree $Path
  if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Recurse -Force }
}
function Install-OwnedFile([string]$Source,[string]$Destination) {
  Assert-Plain $Destination $ComponentHome
  if (Test-Path -LiteralPath $Destination -PathType Container) { throw "Expected an owned file: $Destination" }
  # Replace the directory entry instead of writing through an existing hardlink.
  $next = $Destination + '.new-' + [Guid]::NewGuid().ToString('N')
  Assert-Plain $next $ComponentHome
  try {
    [IO.File]::Copy($Source,$next,$false)
    Assert-Plain $Destination $ComponentHome
    if (Test-Path -LiteralPath $Destination) { [IO.File]::Replace($next,$Destination,$null) }
    else { [IO.File]::Move($next,$Destination) }
  } finally {
    Assert-Plain $next $ComponentHome
    if (Test-Path -LiteralPath $next) { Remove-Item -LiteralPath $next -Force }
  }
}
function Enter-InstallLock {
  $path = Join-Path $ComponentHome '.native-host.lock'
  Assert-Plain $path $ComponentHome
  if ($MaintenanceLock) {
    if (-not $MaintenanceLock.CanRead -or -not $MaintenanceLock.CanWrite -or $MaintenanceLock.SafeFileHandle.IsClosed -or $MaintenanceLock.SafeFileHandle.IsInvalid) { throw 'Invalid maintenance lock stream' }
    if (-not ('AnagramInstallerHandle' -as [type])) {
      Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class AnagramInstallerHandle {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint size, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool WriteFile(SafeFileHandle handle, byte[] bytes, uint count, out uint written, IntPtr overlapped);
  public static string Path(SafeFileHandle handle) {
    var path = new StringBuilder(32768);
    uint count = GetFinalPathNameByHandle(handle, path, (uint)path.Capacity, 0);
    if (count == 0 || count >= path.Capacity) throw new Win32Exception();
    string result = path.ToString();
    if (result.StartsWith(@"\\?\UNC\")) return @"\\" + result.Substring(8);
    return result.StartsWith(@"\\?\") ? result.Substring(4) : result;
  }
  public static void VerifyWrite(SafeFileHandle handle) {
    uint written;
    if (!WriteFile(handle, new byte[] { 0 }, 1, out written, IntPtr.Zero) || written != 1)
      throw new Win32Exception();
  }
}
'@
    }
    if ([AnagramInstallerHandle]::Path($MaintenanceLock.SafeFileHandle) -ne $path) { throw 'Maintenance handle is not the owned lock file' }
    # A second handle must be unable to lock the range; the supplied handle must
    # still be able to write it. This rejects an unlocked stream and a stream to
    # a range actually held by another process/handle.
    $probe = [IO.FileStream]::new($path,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    try {
      $blocked = $false
      try { $probe.Lock(0,1); $probe.Unlock(0,1) }
      catch {
        $failure = $_.Exception
        while ($failure.InnerException) { $failure = $failure.InnerException }
        if (-not ($failure -is [IO.IOException]) -or ($failure.HResult -band 0xffff) -ne 33) { throw }
        $blocked = $true
      }
      if (-not $blocked) { throw 'Maintenance stream does not hold the native lock' }
      $MaintenanceLock.Position = 0
      [AnagramInstallerHandle]::VerifyWrite($MaintenanceLock.SafeFileHandle)
    } finally { $probe.Dispose() }
    return $MaintenanceLock
  }
  $stream = [IO.FileStream]::new($path,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
  try { $stream.Lock(0,1); return $stream }
  catch { $stream.Dispose(); throw 'Another browser or installer is using Anagram. Close its connection and retry.' }
}
function Assert-InstallTargets {
  foreach ($name in @('app','extension','bin','models','venv','python','cache','hf','logs','run','native','tools','.anagram-home','.native-component.json','native-registration.json','.native-host.lock','VERSION','bin\uv.exe','bin\uv.exe.new','bin\anagram-native.exe','bin\anagram-native.exe.new')) { Assert-Plain (Join-Path $ComponentHome $name) $ComponentHome }
  foreach ($name in @('app.old','extension.old','venv.old','venv.next')) {
    $path = Join-Path $ComponentHome $name
    Assert-Plain $path $ComponentHome
    if (Test-Path -LiteralPath $path) { throw "Unfinished previous installation at $path; restore it before retrying." }
  }
}
function Undo-Install([string[]]$Swapped,[bool]$CreatedVenv,[bool]$LauncherWritten,[bool]$VersionWritten,[string]$LauncherBackup,[string]$VersionBackup) {
  if ($CreatedVenv) { Remove-OwnedTree (Join-Path $ComponentHome 'venv.next') }
  if ($LauncherWritten) {
    if ($LauncherBackup -and (Test-Path -LiteralPath $LauncherBackup)) { Install-OwnedFile $LauncherBackup (Join-Path $ComponentHome 'bin\anagram-native.exe') }
    else { Remove-OwnedTree (Join-Path $ComponentHome 'bin\anagram-native.exe') }
  }
  if ($VersionWritten) {
    if ($VersionBackup -and (Test-Path -LiteralPath $VersionBackup)) { Install-OwnedFile $VersionBackup (Join-Path $ComponentHome 'VERSION') }
    else { Remove-OwnedTree (Join-Path $ComponentHome 'VERSION') }
  }
  if (-not $Swapped) { return }
  $reverse = @($Swapped)
  [Array]::Reverse($reverse)
  foreach ($path in $reverse) {
    Remove-OwnedTree $path
    Assert-Plain ($path + '.old') $ComponentHome
    if (Test-Path -LiteralPath ($path + '.old')) { Move-Item -LiteralPath ($path + '.old') -Destination $path }
  }
}
function Fetch([string]$Url,[string]$Out) {
  $uri = [Uri]$Url
  if ($uri.Scheme -eq 'file') { Copy-Item -LiteralPath $uri.LocalPath -Destination $Out }
  elseif ($uri.Scheme -eq 'https') { Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Out }
  else { throw 'Release download must use HTTPS (or a local file URI for an explicit offline install)' }
}
function Hash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Invoke-Private([string]$Program,[string[]]$Arguments) {
  $saved = @{}
  Get-ChildItem Env: | ForEach-Object { $saved[$_.Name] = $_.Value }
  try {
    Get-ChildItem Env: | ForEach-Object { Remove-Item -LiteralPath ("Env:" + $_.Name) }
    foreach ($key in @('USERPROFILE','LOCALAPPDATA','APPDATA','SystemRoot','WINDIR','TEMP','TMP','http_proxy','https_proxy','HTTP_PROXY','HTTPS_PROXY','NO_PROXY','no_proxy','SSL_CERT_FILE','SSL_CERT_DIR','REQUESTS_CA_BUNDLE')) {
      if ($saved.ContainsKey($key)) { [Environment]::SetEnvironmentVariable($key,$saved[$key],'Process') }
    }
    $env:PATH = Join-Path $env:SystemRoot 'System32'
    $env:UV_CACHE_DIR = Join-Path $ComponentHome 'cache'
    $env:UV_PYTHON_INSTALL_DIR = Join-Path $ComponentHome 'python'
    $env:UV_PYTHON_BIN_DIR = Join-Path $ComponentHome 'python\bin'
    $env:UV_TOOL_DIR = Join-Path $ComponentHome 'tools'
    $env:UV_TOOL_BIN_DIR = Join-Path $ComponentHome 'tools\bin'
    $env:UV_PROJECT_ENVIRONMENT = Join-Path $ComponentHome 'venv.next'
    $env:UV_PYTHON_PREFERENCE = 'only-managed'
    $env:UV_NO_CONFIG = '1'; $env:UV_NO_MODIFY_PATH = '1'; $env:UV_NO_PROGRESS = '1'
    $env:HF_HOME = Join-Path $ComponentHome 'hf'; $env:XDG_CACHE_HOME = Join-Path $ComponentHome 'cache'
    $env:HF_HUB_DISABLE_IMPLICIT_TOKEN = '1'; $env:HF_HUB_DISABLE_TELEMETRY = '1'
    $env:PYTHONNOUSERSITE = '1'; $env:PYTHONSAFEPATH = '1'
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Private command failed with exit $LASTEXITCODE" }
  } finally {
    Get-ChildItem Env: | ForEach-Object { Remove-Item -LiteralPath ("Env:" + $_.Name) }
    foreach ($key in $saved.Keys) { [Environment]::SetEnvironmentVariable($key,$saved[$key],'Process') }
  }
}

if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { throw 'The locked Windows runtime currently supports x64 Windows only.' }
if ($Browser -eq 'chrome') { if ($ExtensionId -cnotmatch '^[a-p]{32}$') { throw 'Chrome extension ID must be exactly 32 a-p characters.' } }
elseif ($Browser -eq 'firefox') { if ($ExtensionId -ne 'anagram@coderbak.dev') { throw 'Firefox extension ID must be anagram@coderbak.dev.' } }
else { throw 'Use the browser-specific command from Anagram setup.' }
if (-not [IO.Path]::IsPathRooted($ComponentHome) -or $ComponentHome -match '(^|[\\/])\.\.?([\\/]|$)') { throw 'ComponentHome must be an absolute dedicated directory without . or .. segments.' }
$ComponentHome = [IO.Path]::GetFullPath($ComponentHome).TrimEnd('\')
$protected = @([IO.Path]::GetPathRoot($ComponentHome).TrimEnd('\'),$env:USERPROFILE,$env:LOCALAPPDATA,$env:APPDATA,$env:SystemRoot,$env:ProgramFiles,${env:ProgramFiles(x86)})
if ($protected -contains $ComponentHome) { throw 'Refusing to install into a shared/system directory.' }
Assert-Plain $ComponentHome ([IO.Path]::GetPathRoot($ComponentHome))
$marker = Join-Path $ComponentHome '.anagram-home'
if (Test-Path -LiteralPath $ComponentHome) {
  if (-not (Test-Path -LiteralPath $ComponentHome -PathType Container)) { throw 'ComponentHome is not a directory.' }
  if (-not (Test-Path -LiteralPath $marker -PathType Leaf) -and @(Get-ChildItem -LiteralPath $ComponentHome -Force).Count -gt 0) { throw 'Existing nonempty directory is not an Anagram installation.' }
}
Assert-InstallTargets
$null = New-Item -ItemType Directory -Path $ComponentHome -Force
$installLock = $null; $temporary = $null
$swapped = @(); $completed = $false; $createdVenv = $false
$launcherWritten = $false; $versionWritten = $false
$launcherBackup = $null; $versionBackup = $null
try {
  $installLock = Enter-InstallLock
  # Validate again under the lock, before creating or replacing installation data.
  Assert-Plain $ComponentHome ([IO.Path]::GetPathRoot($ComponentHome))
  Assert-InstallTargets
  foreach ($name in @('bin','models','cache','hf','run')) { $null = New-Item -ItemType Directory -Path (Join-Path $ComponentHome $name) -Force }
  if (-not (Test-Path -LiteralPath $marker)) { Set-Content -LiteralPath $marker -Value 'Anagram installation folder.' -Encoding ASCII }
  $temporary = Join-Path ([IO.Path]::GetTempPath()) ('anagram-install-' + [Guid]::NewGuid().ToString('N'))
  $null = New-Item -ItemType Directory -Path $temporary
  $launcherBackup = Join-Path $temporary 'launcher.backup'
  $versionBackup = Join-Path $temporary 'version.backup'
  if (Test-Path -LiteralPath (Join-Path $ComponentHome 'bin\anagram-native.exe')) { Copy-Item -LiteralPath (Join-Path $ComponentHome 'bin\anagram-native.exe') -Destination $launcherBackup }
  if (Test-Path -LiteralPath (Join-Path $ComponentHome 'VERSION')) { Copy-Item -LiteralPath (Join-Path $ComponentHome 'VERSION') -Destination $versionBackup }
  Say 'Downloading and verifying the Anagram release…' '正在下载并校验 Anagram 安装包…'
  $archive = Join-Path $temporary 'anagram.zip'; $checksum = $archive + '.sha256'
  Fetch ($ReleaseUrl.TrimEnd('/') + '/anagram.zip') $archive
  Fetch ($ReleaseUrl.TrimEnd('/') + '/anagram.zip.sha256') $checksum
  $expected = ((Get-Content -LiteralPath $checksum -Raw).Trim() -split '\s+')[0]
  if ($expected -cnotmatch '^[0-9a-f]{64}$' -or (Hash $archive) -ne $expected) { throw 'Release checksum mismatch.' }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  # Reject paths that escape extraction, duplicate entries, and Unix symlink entries.
  $zip = [IO.Compression.ZipFile]::OpenRead($archive)
  try {
    $seen = @{}
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName.Replace('\','/')
      if ($name -notlike 'anagram/*' -or $name -match '(^|/)\.\.(/|$)' -or $name.Contains(':') -or $seen.ContainsKey($name)) { throw 'Unsafe release ZIP entry.' }
      if ((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'Symlink in release ZIP refused.' }
      $seen[$name] = $true
    }
  } finally { $zip.Dispose() }
  [IO.Compression.ZipFile]::ExtractToDirectory($archive,(Join-Path $temporary 'release'))
  $release = Join-Path $temporary 'release\anagram'
  foreach ($name in @('app\native_host.py','app\native_registration.py','app\uv.lock','app\NativeLauncher.cs','install.ps1','VERSION')) {
    if (-not (Test-Path -LiteralPath (Join-Path $release $name) -PathType Leaf)) { throw "Release file missing: $name" }
  }
  # Fetch/bootstrap before replacing app; preserve previous app until registration succeeds.
  $uv = Join-Path $ComponentHome 'bin\uv.exe'
  # `uv --version` appends build details ("uv 0.11.18 (abc123 date)"); compare the version field.
  if (-not (Test-Path -LiteralPath $uv) -or ("$(& $uv --version)" -split ' ')[1] -ne $UvVersion) {
    $uvZip = Join-Path $temporary 'uv.zip'
    Fetch "https://github.com/astral-sh/uv/releases/download/$UvVersion/uv-x86_64-pc-windows-msvc.zip" $uvZip
    if ((Hash $uvZip) -ne $UvHash) { throw 'uv checksum mismatch.' }
    [IO.Compression.ZipFile]::ExtractToDirectory($uvZip,(Join-Path $temporary 'uv'))
    $uvSource = @(Get-ChildItem -LiteralPath (Join-Path $temporary 'uv') -Recurse -Filter uv.exe)[0].FullName
    Install-OwnedFile $uvSource $uv
  }
  foreach ($name in @('app','extension')) {
    $source = Join-Path $release $name
    if ($name -eq 'extension' -and $Browser -eq 'firefox') { $source = Join-Path $release 'extension-firefox' }
    if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "Release directory missing: $name" }
    $destination = Join-Path $ComponentHome $name
    Assert-Plain ($destination + '.old') $ComponentHome
    if (Test-Path -LiteralPath ($destination + '.old')) { throw "Unfinished previous update at $destination.old; restore it before retrying." }
    if (Test-Path -LiteralPath $destination) { Move-Item -LiteralPath $destination -Destination ($destination + '.old') }
    $swapped += $destination
    Copy-Item -LiteralPath $source -Destination $destination -Recurse
  }
  Install-OwnedFile (Join-Path $release 'install.ps1') (Join-Path $ComponentHome 'app\install.ps1')
  Say 'Installing private Python and locked runtime packages…' '正在安装独立 Python 和版本锁定的运行依赖…'
  Invoke-Private $uv @('python','install',$PythonVersion,'--quiet')
  Push-Location (Join-Path $ComponentHome 'app')
  # Pre-existing staging was refused before any writes. Only this transaction's
  # venv.next may be removed by failure cleanup.
  $createdVenv = $true
  try { Invoke-Private $uv @('sync','--frozen','--no-dev','--no-build','--python',$PythonVersion,'--quiet') } finally { Pop-Location }
  $stagedVenv = Join-Path $ComponentHome 'venv.next'
  if (-not (Test-Path -LiteralPath (Join-Path $stagedVenv 'Scripts\python.exe') -PathType Leaf)) { throw 'Staged private Python was not created.' }
  $venv = Join-Path $ComponentHome 'venv'
  Assert-Plain $stagedVenv $ComponentHome; Assert-Plain ($venv + '.old') $ComponentHome
  if (Test-Path -LiteralPath ($venv + '.old')) { throw 'An unfinished previous venv update exists.' }
  if (Test-Path -LiteralPath $venv) { Move-Item -LiteralPath $venv -Destination ($venv + '.old') }
  $swapped += $venv
  Move-Item -LiteralPath $stagedVenv -Destination $venv
  $createdVenv = $false
  $python = Join-Path $ComponentHome 'venv\Scripts\python.exe'
  if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { throw 'Private Python was not installed.' }
  Say 'Building the local native launcher…' '正在构建本地通信启动程序…'
  $launcher = Join-Path $ComponentHome 'bin\anagram-native.exe'
  Assert-Plain $launcher $ComponentHome; Assert-Plain ($launcher + '.new') $ComponentHome
  $compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  if (-not (Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework C# compiler is unavailable.' }
  $compiledLauncher = Join-Path $temporary 'anagram-native.exe'
  & $compiler /nologo /target:exe /optimize+ ("/out:" + $compiledLauncher) (Join-Path $ComponentHome 'app\NativeLauncher.cs')
  if ($LASTEXITCODE -ne 0) { throw 'Native launcher compilation failed.' }
  $launcherWritten = $true
  Install-OwnedFile $compiledLauncher $launcher
  $versionWritten = $true
  Install-OwnedFile (Join-Path $release 'VERSION') (Join-Path $ComponentHome 'VERSION')
  Say 'Registering this extension only…' '正在为当前扩展注册本地组件…'
  Invoke-Private $python @('-I',(Join-Path $ComponentHome 'app\native_registration.py'),'register','--home',$ComponentHome,'--browser',$Browser,'--extension-id',$ExtensionId,'--language',$Language)
  $completed = $true
  foreach ($path in $swapped) { Remove-OwnedTree ($path + '.old') }
  Say 'Preparing device-selected model files with Hugging Face…' '正在使用 Hugging Face 下载适合本机设备的模型文件…'
  Invoke-Private $python @('-I',(Join-Path $ComponentHome 'app\prepare_models.py'),'--home',$ComponentHome,'--installer','--language',$Language)
  Say 'Installed. Model files are ready; the browser finishes setup automatically.' '安装完成。模型文件已准备就绪，浏览器将自动完成剩余设置。'
  Say 'EditLens models are licensed CC BY-NC-SA 4.0, for noncommercial use only.' 'EditLens 模型采用 CC BY-NC-SA 4.0 许可，仅限非商业用途。'
} finally {
  try {
    if ($installLock -and -not $completed) {
      Undo-Install $swapped $createdVenv $launcherWritten $versionWritten $launcherBackup $versionBackup
    }
    if ($temporary -and (Test-Path -LiteralPath $temporary)) { Remove-Item -LiteralPath $temporary -Recurse -Force }
  } finally {
    if ($installLock -and -not $MaintenanceLock) { $installLock.Dispose() }
  }
}
