# Anagram native component installer for Windows x64, Windows PowerShell 5.1+.
# Run the exact browser-specific command shown in Anagram setup. No admin, PATH,
# login startup, system Python, model download, or HTTP server is required.
[CmdletBinding()]
param(
  [string]$ExtensionId = $env:ANAGRAM_EXTENSION_ID,
  [ValidateSet('chrome','firefox')][string]$Browser = $env:ANAGRAM_BROWSER,
  [ValidateSet('en','zh_CN')][string]$Language = $(if ($env:ANAGRAM_LANG) {$env:ANAGRAM_LANG} else {'en'}),
  [string]$ComponentHome = $(if ($env:ANAGRAM_HOME) {$env:ANAGRAM_HOME} else {Join-Path $env:LOCALAPPDATA 'Anagram'}),
  [string]$ReleaseUrl = $(if ($env:ANAGRAM_RELEASE_URL) {$env:ANAGRAM_RELEASE_URL} else {'https://github.com/CoderBak/anagram/releases/latest/download'})
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
    if (Test-Path -LiteralPath $current) {
      if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Symbolic link/reparse point refused: $current" }
    }
    if ($current -eq $base) { break }
    $current = Split-Path -Parent $current
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
foreach ($name in @('app','bin','models','venv','python','cache','hf','logs','run','native','tools','venv.next','venv.old','.anagram-home','.native-component.json','native-registration.json')) { Assert-Plain (Join-Path $ComponentHome $name) $ComponentHome }
$null = New-Item -ItemType Directory -Path $ComponentHome -Force
foreach ($name in @('bin','models','cache','hf','logs','run')) { $null = New-Item -ItemType Directory -Path (Join-Path $ComponentHome $name) -Force }
if (-not (Test-Path -LiteralPath $marker)) { Set-Content -LiteralPath $marker -Value 'Anagram installation folder.' -Encoding ASCII }
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('anagram-install-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $temporary
$swapped = @(); $completed = $false
$launcherBackup = Join-Path $temporary 'launcher.backup'
$versionBackup = Join-Path $temporary 'version.backup'
if (Test-Path -LiteralPath (Join-Path $ComponentHome 'bin\anagram-native.exe')) { Copy-Item -LiteralPath (Join-Path $ComponentHome 'bin\anagram-native.exe') -Destination $launcherBackup }
if (Test-Path -LiteralPath (Join-Path $ComponentHome 'VERSION')) { Copy-Item -LiteralPath (Join-Path $ComponentHome 'VERSION') -Destination $versionBackup }
try {
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
  if (-not (Test-Path -LiteralPath $uv) -or (& $uv --version) -ne "uv $UvVersion") {
    $uvZip = Join-Path $temporary 'uv.zip'
    Fetch "https://github.com/astral-sh/uv/releases/download/$UvVersion/uv-x86_64-pc-windows-msvc.zip" $uvZip
    if ((Hash $uvZip) -ne $UvHash) { throw 'uv checksum mismatch.' }
    [IO.Compression.ZipFile]::ExtractToDirectory($uvZip,(Join-Path $temporary 'uv'))
    $uvSource = @(Get-ChildItem -LiteralPath (Join-Path $temporary 'uv') -Recurse -Filter uv.exe)[0].FullName
    Copy-Item -LiteralPath $uvSource -Destination ($uv + '.new'); Move-Item -LiteralPath ($uv + '.new') -Destination $uv -Force
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
  Copy-Item -LiteralPath (Join-Path $release 'install.ps1') -Destination (Join-Path $ComponentHome 'app\install.ps1')
  Say 'Installing private Python and locked runtime packages…' '正在安装独立 Python 和版本锁定的运行依赖…'
  Invoke-Private $uv @('python','install',$PythonVersion,'--quiet')
  Push-Location (Join-Path $ComponentHome 'app')
  try { Invoke-Private $uv @('sync','--frozen','--no-dev','--python',$PythonVersion,'--quiet') } finally { Pop-Location }
  $stagedVenv = Join-Path $ComponentHome 'venv.next'
  if (-not (Test-Path -LiteralPath (Join-Path $stagedVenv 'Scripts\python.exe') -PathType Leaf)) { throw 'Staged private Python was not created.' }
  $venv = Join-Path $ComponentHome 'venv'
  Assert-Plain $stagedVenv $ComponentHome; Assert-Plain ($venv + '.old') $ComponentHome
  if (Test-Path -LiteralPath ($venv + '.old')) { throw 'An unfinished previous venv update exists.' }
  if (Test-Path -LiteralPath $venv) { Move-Item -LiteralPath $venv -Destination ($venv + '.old') }
  $swapped += $venv
  Move-Item -LiteralPath $stagedVenv -Destination $venv
  $python = Join-Path $ComponentHome 'venv\Scripts\python.exe'
  if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { throw 'Private Python was not installed.' }
  Say 'Building the local native launcher…' '正在构建本地通信启动程序…'
  $launcher = Join-Path $ComponentHome 'bin\anagram-native.exe'
  Assert-Plain $launcher $ComponentHome; Assert-Plain ($launcher + '.new') $ComponentHome
  $compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  if (-not (Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework C# compiler is unavailable.' }
  & $compiler /nologo /target:exe /optimize+ ("/out:" + $launcher + '.new') (Join-Path $ComponentHome 'app\NativeLauncher.cs')
  if ($LASTEXITCODE -ne 0) { throw 'Native launcher compilation failed.' }
  Move-Item -LiteralPath ($launcher + '.new') -Destination $launcher -Force
  Copy-Item -LiteralPath (Join-Path $release 'VERSION') -Destination (Join-Path $ComponentHome 'VERSION')
  Say 'Registering this extension only…' '正在为当前扩展注册本地组件…'
  Invoke-Private $python @('-I',(Join-Path $ComponentHome 'app\native_registration.py'),'register','--home',$ComponentHome,'--browser',$Browser,'--extension-id',$ExtensionId,'--language',$Language)
  $completed = $true
  foreach ($path in $swapped) { if (Test-Path -LiteralPath ($path + '.old')) { Remove-Item -LiteralPath ($path + '.old') -Recurse -Force } }
  Say 'Installed. Return to the extension and reconnect to download models and compare configurations.' '安装完成。请返回扩展并重新连接，继续下载模型和比较配置。'
  Say 'EditLens: CC BY-NC-SA 4.0, noncommercial use. Initial model download is 4.07 GB plus temporary space.' 'EditLens 采用 CC BY-NC-SA 4.0 许可，仅限非商业用途。首次模型下载约 4.07 GB，另需临时空间。'
} finally {
  if (-not $completed) {
    $leftoverVenv = Join-Path $ComponentHome 'venv.next'
    Assert-Plain $leftoverVenv $ComponentHome
    if (Test-Path -LiteralPath $leftoverVenv) { Remove-Item -LiteralPath $leftoverVenv -Recurse -Force }
    if (Test-Path -LiteralPath $launcherBackup) { Copy-Item -LiteralPath $launcherBackup -Destination (Join-Path $ComponentHome 'bin\anagram-native.exe') -Force }
    if (Test-Path -LiteralPath $versionBackup) { Copy-Item -LiteralPath $versionBackup -Destination (Join-Path $ComponentHome 'VERSION') -Force }
    [Array]::Reverse($swapped)
    foreach ($path in $swapped) {
      Assert-Plain $path $ComponentHome
      if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
      if (Test-Path -LiteralPath ($path + '.old')) { Move-Item -LiteralPath ($path + '.old') -Destination $path }
    }
  }
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
}
