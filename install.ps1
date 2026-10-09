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
    if ($script:PythonFrom) { $env:UV_PYTHON_INSTALL_MIRROR = $script:PythonFrom }
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

# Where PyPI, GitHub or the Python builds are slow or blocked (mainland China, a company
# network), people point pip and uv at a mirror; the installer takes the same one. The
# lock's hashes, uv's checksums for Python and the pinned checksum of uv still decide every
# file, so a mirror changes where the files come from, never what they are. When a mirror
# fails, the original source is tried.
function Mirror-Url([string]$Value) {
  if ($Value -cmatch '^https?://[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+$') { return $Value.TrimEnd('/') }
  return $null
}
function Url-Host([string]$Url) { return ((($Url -replace '^[a-z]+://','') -replace '/.*$','') -replace '^.*@','') }
function First-Mirror([object[]]$Candidates) {
  foreach ($candidate in $Candidates) { $url = Mirror-Url "$candidate"; if ($url) { return $url } }
  return $null
}
function Mirror-Failed([string]$Url) { Say "$(Url-Host $Url) did not work; trying the original source" "$(Url-Host $Url) 无法使用，改用原始来源" }
function Under([string]$Base,[string]$Child) { if ($Base) { return (Join-Path $Base $Child) } else { return $null } }
# index-url in the [global] or [install] section of a pip configuration file.
function Pip-ConfIndex([string]$Path) {
  if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  $section = ''
  foreach ($line in [IO.File]::ReadAllLines($Path)) {
    if ($line -match '^\s*[#;]') { continue }
    if ($line -match '^\s*\[') { $section = ($line -replace '\s','').ToLowerInvariant(); continue }
    if (($section -eq '[global]' -or $section -eq '[install]') -and $line -match '^\s*index[-_]url\s*=\s*(.*?)\s*$') { return $Matches[1] }
  }
  return $null
}
# From a uv.toml: the [[index]] marked default (or the older index-url), or python-install-mirror.
function Uv-TomlValue([string]$Path,[string]$Want) {
  if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  $table = ''; $url = $null; $isDefault = $false; $chosen = $null; $top = $null; $python = $null
  foreach ($line in @([IO.File]::ReadAllLines($Path)) + '[end]') {
    if ($line -match '^\s*#') { continue }
    if ($line -match '^\s*\[') {
      if ($table -eq '[[index]]' -and $isDefault -and $url -and -not $chosen) { $chosen = $url }
      $table = ($line -replace '#.*$','') -replace '\s',''; $url = $null; $isDefault = $false; continue
    }
    if ($line -notmatch '^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$') { continue }
    $key = $Matches[1]; $raw = $Matches[2]; $value = $null
    if ($raw -match '^"([^"]*)"' -or $raw -match "^'([^']*)'") { $value = $Matches[1] }
    if ($table -eq '[[index]]') { if ($key -eq 'url') { $url = $value } elseif ($key -eq 'default' -and $raw -match '^true') { $isDefault = $true } }
    elseif (($table -eq '' -or $table -eq '[pip]') -and $key -eq 'index-url' -and -not $top) { $top = $value }
    elseif ($table -eq '' -and $key -eq 'python-install-mirror') { $python = $value }
  }
  if ($Want -eq 'python') { return $python }
  if ($chosen) { return $chosen }
  return $top
}
$uvConfig = if ($env:UV_CONFIG_FILE) { $env:UV_CONFIG_FILE } else { Under $env:APPDATA 'uv\uv.toml' }
$PypiIndex = First-Mirror @($env:UV_DEFAULT_INDEX, $env:UV_INDEX_URL, $env:PIP_INDEX_URL, (Uv-TomlValue $uvConfig 'index'),
  (Pip-ConfIndex $env:PIP_CONFIG_FILE), (Pip-ConfIndex (Under $env:APPDATA 'pip\pip.ini')), (Pip-ConfIndex (Under $env:USERPROFILE 'pip\pip.ini')), (Pip-ConfIndex (Under $env:ProgramData 'pip\pip.ini')))
$PythonMirror = First-Mirror @($env:UV_PYTHON_INSTALL_MIRROR, (Uv-TomlValue $uvConfig 'python'))
$UvGithub = First-Mirror @($env:UV_INSTALLER_GITHUB_BASE_URL)
$script:PythonFrom = $null

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
# A release fetched over HTTPS is used only if its Sigstore bundle verifies: signed by
# .github/workflows/release.yml in GitHub Actions at the release's tag, and by nothing else
# (installer/verify_release.py, run with sigstore-python in a throwaway environment, every
# file's hash pinned). A release given as a local file is one's own build, checked by its
# checksum alone.
$SigstoreRequirements = @'
# >>> generated by scripts/sigstoreLock.mjs from installer/sigstore.in
annotated-types==0.8.0 --hash=sha256:f072f4d804ea359e4eaf198b1af7a8b0943881a87f31bb764f8bf219bb9419e0
certifi==2026.7.22 --hash=sha256:62f22742b58a1a33014a2b6b706588a8d7e2a88ae7bd1a6ebe8c992928483775
cffi==2.1.1 ; platform_python_implementation != 'PyPy' --hash=sha256:68e62fe11f30d5ca8289242866f0a5291402d8529ca2178ab8afc5c9694ae890 --hash=sha256:c1453022f490d2459a11819d83ad1d586e9ff65a12ac3e705ffebd46d3685dcf --hash=sha256:f53e442b08449d42821fa4a4fba000095af9f62742a500f978a9f557ec44339a --hash=sha256:f81b3b8f3d4e343550fa4baa0e479bba9f2d29ce9c2e9b51d1ce1718d7442fcf
charset-normalizer==3.5.2 --hash=sha256:1c50fe28bbc2ced33386f298650d91218076c05420e6cbd790b913adc41659e7 --hash=sha256:3d31298449090ab8d47b7b1b2a555ff73cac7ed438a08b7ac160980c7ebed649 --hash=sha256:4275811936e2f06feff5e598fb42a1b7ae852da8e39605211892b56b81a34efd --hash=sha256:780fbe7cab297b81dad9fb8dc5eb003c0468ffb0d9e5f65068c53a34661a96bc --hash=sha256:9f56f72050826f63dcee7a7f55b0a77168cb3bfc553fd405e7f8f9ece75a4036 --hash=sha256:b6b751274acb69d77b3323d6b7dbaa3c7fdfc1eb829b7eb61d262f32e1af9685 --hash=sha256:b91363207bd9dc966a691e959bb47f64b30f7ac4b072be9968b366982f7db77c --hash=sha256:d19fbd981a488e22cd04883659ca6b08f50b5974f9fd7c95655ef6a043e5893f --hash=sha256:ed2a239c0ea213acc1908150a3037257083c7c083128f1a4cec2ec4b97dca491
cryptography==50.0.2 --hash=sha256:0ddc924c04591c2811ca024d62ecad4f7f6f08af8939c211438f48a16bd23602 --hash=sha256:0ec5f09541743261e66e291b4a0cbf0fb2997aeaab6d9e9c740b9dba1b58d1c2 --hash=sha256:1981f1db4630889b9ef7803fadef12b056f428cb6b85c27ba57b774793b6093c --hash=sha256:4061c0079120205fb760c58acab6443e217307dcf05e3702cf970e0689972856 --hash=sha256:4e81d95e5bafc2d6e34e4bed780e53e4d5b9a2f928573428aa4d35fbec1eb0de --hash=sha256:630ebfea3bf689d075f82316324ff7433dc447fe6bc1bfc76524b74b4a9567d2 --hash=sha256:79def8d059362e7831389ed3be0ecdf58a89386e1271e35dd9f5af84e81bffd0 --hash=sha256:7afa5a6602a9f29af1f3a2965f831bae7c9d5d597b7cbb716d41ab3b7d89879c --hash=sha256:87e9ce85beb6b328ba370cc6e6aea483c92617b4c95b1d33a49297eb662bfb04 --hash=sha256:9dab55f57c74c3cad24c323bacbbd04be4705ba6eb0d92e920b1fc4837ed5079 --hash=sha256:c5e67125c7dca78d199ec4e116aa93dbb83494808ecbb8211a2cb09b1bf41dbd --hash=sha256:dfe9763530994147d9af1def057a5b9658b00e8f8fe8743d144d1e0911c2e454 --hash=sha256:ee247f5c245c9a2fe7c8e2214e295918838e44e00a45a6718451e4004219e767 --hash=sha256:f21e8a22c8605750c7af886bab299a363721264061b4ac0a30efb73cfd58efc5 --hash=sha256:f9f6143a8c75945eb960d9eb98905a441394abfa24afaae239d514ffb2586480 --hash=sha256:fa8f5efb344d6908a1ce62f4a24e2e5780f825d6f53f5f50ec5ffacac72936cb
dnspython==2.9.0 --hash=sha256:9a4aedb833c3c1b49214d04d44d3032ab7a9135f7c1d29a549b4ff78fd82fda9
email-validator==2.3.0 --hash=sha256:80f13f623413e6b197ae73bb10bf4eb0908faf509ad8362c5edeb0be7fd450b4
id==1.6.1 --hash=sha256:f5ec41ed2629a508f5d0988eda142e190c9c6da971100612c4de9ad9f9b237ca
idna==3.20 --hash=sha256:ab7ae7122974553370f0bdb919e1a960b2cd1bc1ef0276416d896db81c14582c
markdown-it-py==4.2.0 --hash=sha256:9f7ebbcd14fe59494226453aed97c1070d83f8d24b6fc3a3bcf9a38092641c4a
mdurl==0.1.2 --hash=sha256:84008a41e51615a49fc9966191ff91509e3c40b939176e643fd50a5c2196b8f8
platformdirs==4.12.4 --hash=sha256:78bfb9db2a8471ed7eebe3c3c932da413911042994e699b384fbb4493fa872d7
pyasn1==0.6.4 --hash=sha256:deda9277cfd454080ec40b207fb6df82206a3a2688735233cdcd8d3d565f088b
pycparser==3.11 ; implementation_name != 'PyPy' and platform_python_implementation != 'PyPy' --hash=sha256:51d5a8ba2be0bbe440b99d2112604c95bbbc3c2748a64260186c541e1729cd80
pydantic==2.14.0 --hash=sha256:15fab1bea6f1dc5003b54fc2ecab230c1fd1dbade2acd4addc52d81e32416d4b
pydantic-core==2.50.0 --hash=sha256:0abe1b44d361b948404b6b2ed80be2583e0077340572e071afa6e0eda4e1de30 --hash=sha256:1541c334af5d42cb9eb03862a9b4d2cfbfc670fd05172ec51f3ce02d704550f1 --hash=sha256:ae45853d25a23fba56681d2f9ed41f3e3f12f0a3b2393fefa08ff6406320a1f5 --hash=sha256:f187030fc3d62c668feb0f09e92852e0eb414d7fcefc4748f2e67d245aade37e
pygments==2.21.0 --hash=sha256:2363c69b61c4a97c838da3b130dcd6468f4848992b21a82f2a63ec34377137d9
pyjwt==2.15.1 --hash=sha256:42d59d631f7768a1028a64c7ff581a9bf7519804daf91fc5b6c56e30eec5e193
pyopenssl==26.4.0 --hash=sha256:f0eb0cb2d581d3ad2b9c489468485e7f2ab6727d08401bcf9d824c3caddf3c1c
requests==2.34.2 --hash=sha256:2a0d60c172f83ac6ab31e4554906c0f3b3588d37b5cb939b1c061f4907e278e0
rfc3161-client==1.0.9 --hash=sha256:7b703b233dbee7228d117d5f1c118363c61d523fa6f018c9217c79e3c6684f86 --hash=sha256:908f6a775da4bdce1d39f825a4431f389542696078ef3e4ed911a068bcaf1792 --hash=sha256:a7004edfbf1bb7ec7801978a39fa7a7fe385ca59673df90d7578079b6eba3b24 --hash=sha256:fac3f440a507555e684dc5daba75e33dc08f0f45fdefa48448f19001233a6b21
rfc8785==0.1.4 --hash=sha256:520d690b448ecf0703691c76e1a34a24ddcd4fc5bc41d589cb7c58ec651bcd48
rich==15.0.0 --hash=sha256:33bd4ef74232fb73fe9279a257718407f169c09b78a87ad3d296f548e27de0bb
securesystemslib==1.5.1 --hash=sha256:ada8bdf817da29ece4ba91654f6a162ce7cfbadbc3ae3f840f7313f9d22675de
sigstore==4.5.0 --hash=sha256:f045b207f2e12605cf775ec38e89c5eda625d71ffa7830477db65e47ec2bc8b2
sigstore-models==0.0.6 --hash=sha256:5201a68f4d7d0f8bec1e2f4378eb646b084c52609a4e31db8c385095fff68b2e
sigstore-rekor-types==0.0.18 --hash=sha256:b62bf38c5b1a62bc0d7fe0ee51a0709e49311d137c7880c329882a8f4b2d1d78
tuf==7.0.1 --hash=sha256:d30434bda6e079ab303fb30d1b3006d939a10ca34783b1573d61cd9b802fa45c
typing-extensions==4.16.0 --hash=sha256:481caa481374e813c1b176ada14e97f1f67a4539ce9cfeb3f350d78d6370c2e8
typing-inspection==0.4.4 --hash=sha256:65b8397ba37ccbce054456aaccddfc91e6e3083c92824df348d96ca832f3f147
urllib3==2.8.0 --hash=sha256:0cf3cae568d36aa9576b28dfb35f11328f1cb974ca7647d9475ebb86c75ac6e3
# <<< generated
'@
$VerifyReleaseScript = @'
# >>> installer/verify_release.py, copied by scripts/sigstoreLock.mjs
"""Verify a release's Sigstore bundle before anything of the release is used.

A release is signed by .github/workflows/release.yml, run in GitHub Actions at the release's
tag, and by nothing else: Sigstore keyless signing names that workflow, its repository and
the tag in a certificate the public log records. install.sh and install.ps1 carry this file
(scripts/sigstoreLock.mjs copies it in) and run it with sigstore-python, installed with every
file's hash pinned, before they open the archive:

    python -I verify_release.py ARCHIVE BUNDLE [VERSION]

It prints the version the signature names and exits 0, or says why not and exits 1. VERSION,
when given, is the one asked for, and the signature must name it. Sigstore's trust root is
brought up to date where its update server answers, and is otherwise the one sigstore-python
carries (where that server cannot be reached, as in mainland China).
"""
import base64
import hashlib
import json
import logging
import os
import re
import sys
import tempfile

SIGNER = "https://github.com/CoderBak/anagram/.github/workflows/release.yml@refs/tags/v"
ISSUER = "https://token.actions.githubusercontent.com"
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")


def signers(bundle_json):
    """Every name the bundle's certificate is issued to (unverified: what to verify against)."""
    from cryptography import x509

    material = json.loads(bundle_json)["verificationMaterial"]
    raw = (material.get("certificate") or material["x509CertificateChain"]["certificates"][0])["rawBytes"]
    names = x509.load_der_x509_certificate(base64.b64decode(raw)).extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    return [*names.get_values_for_type(x509.UniformResourceIdentifier), *names.get_values_for_type(x509.RFC822Name)]


def signed_version(bundle_json, signer=SIGNER, asked=None):
    """The version of the one release workflow run the certificate names, or None."""
    found = [name[len(signer):] for name in signers(bundle_json) if name.startswith(signer) and VERSION.fullmatch(name[len(signer):])]
    if len(found) != 1 or (asked is not None and found[0] != asked):
        return None
    return found[0]


def verify(archive, bundle_json, identity, issuer=ISSUER, offline=None):
    """Raise unless the bundle is a valid signature of `archive` by `identity`. `offline`: None
    tries Sigstore's update server first."""
    from sigstore.hashes import Hashed
    from sigstore.models import Bundle
    from sigstore.verify import Verifier, policy
    from sigstore_models.common.v1 import HashAlgorithm

    if offline is None:
        try:
            verifier = Verifier.production(offline=False)
        except Exception as error:  # unreachable, or refused: the trust root sigstore-python carries
            print(f"Sigstore's update server did not answer ({type(error).__name__}); using the trust root this verifier carries.", file=sys.stderr)
            verifier = Verifier.production(offline=True)
    else:
        verifier = Verifier.production(offline=offline)
    digest = hashlib.sha256()
    with open(archive, "rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    hashed = Hashed(algorithm=HashAlgorithm.SHA2_256, digest=digest.digest())
    verifier.verify_artifact(hashed, Bundle.from_json(bundle_json), policy.Identity(identity=identity, issuer=issuer))


def main(argv):
    if len(argv) not in (2, 3) or (len(argv) == 3 and not VERSION.fullmatch(argv[2])):
        print("usage: verify_release.py ARCHIVE BUNDLE [VERSION]", file=sys.stderr)
        return 2
    archive, bundle, asked = argv[0], argv[1], (argv[2] if len(argv) == 3 else None)
    # What the installer says is enough: not sigstore-python's notes on how it got its trust root.
    logging.getLogger("sigstore").setLevel(logging.ERROR)
    # Sigstore's trust cache in a place of its own, not the person's home.
    cache = tempfile.mkdtemp(prefix="anagram-sigstore-")
    os.environ.update(XDG_CACHE_HOME=os.path.join(cache, "cache"), XDG_DATA_HOME=os.path.join(cache, "data"))
    with open(bundle, "rb") as stream:
        bundle_json = stream.read()
    try:
        version = signed_version(bundle_json, asked=asked)
    except (ValueError, KeyError, TypeError) as error:
        print(f"The release's signature is not a Sigstore bundle ({error}).", file=sys.stderr)
        return 1
    if version is None:
        wanted = f"{SIGNER}{asked}" if asked else f"{SIGNER}<version>"
        print(f"The release's signature is not from Anagram's release workflow ({wanted}).", file=sys.stderr)
        return 1
    try:
        verify(archive, bundle_json, SIGNER + version)
    except Exception as error:
        print(f"The release's signature does not verify: {error}", file=sys.stderr)
        return 1
    print(version)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
# <<< installer/verify_release.py
'@
function Release-Signature([string]$Archive,[string]$Bundle,[string]$Asked) {
  $verifier = Join-Path $temporary 'verifier'
  $requirements = Join-Path $temporary 'sigstore.txt'; $verify = Join-Path $temporary 'verify_release.py'
  [IO.File]::WriteAllText($requirements, $SigstoreRequirements); [IO.File]::WriteAllText($verify, $VerifyReleaseScript)
  Invoke-Private $uv @('venv','--quiet','--python',$PythonVersion,$verifier)
  $python = Join-Path $verifier 'Scripts\python.exe'
  $installed = $false
  if ($PypiIndex) {
    try { Invoke-Private $uv @('pip','install','--quiet','--python',$python,'--require-hashes','--no-deps','--no-build','--default-index',$PypiIndex,'-r',$requirements); $installed = $true } catch { Mirror-Failed $PypiIndex }
  }
  if (-not $installed) { Invoke-Private $uv @('pip','install','--quiet','--python',$python,'--require-hashes','--no-deps','--no-build','-r',$requirements) }
  $arguments = @('-I',$verify,$Archive,$Bundle)
  if ($Asked) { $arguments += $Asked }
  return @(Invoke-Private $python $arguments)[-1]
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
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  # uv and the private Python come first: the release's signature is checked with them,
  # before anything of the release is opened. The previous app stays until registration succeeds.
  $uv = Join-Path $ComponentHome 'bin\uv.exe'
  # `uv --version` appends build details ("uv 0.11.18 (abc123 date)"); compare the version field.
  if (-not (Test-Path -LiteralPath $uv) -or ("$(& $uv --version)" -split ' ')[1] -ne $UvVersion) {
    $uvZip = Join-Path $temporary 'uv.zip'
    $uvRelease = "https://github.com/astral-sh/uv/releases/download/$UvVersion/uv-x86_64-pc-windows-msvc.zip"
    $fetched = $false
    if ($UvGithub) {
      Say "uv from your mirror, $(Url-Host $UvGithub)" "从你配置的镜像 $(Url-Host $UvGithub) 下载 uv"
      try { Fetch ($UvGithub + $uvRelease.Substring('https://github.com'.Length)) $uvZip; $fetched = (Hash $uvZip) -eq $UvHash } catch { $fetched = $false }
      if (-not $fetched) { Mirror-Failed $UvGithub }
    }
    if (-not $fetched) { Fetch $uvRelease $uvZip }
    if ((Hash $uvZip) -ne $UvHash) { throw 'uv checksum mismatch.' }
    [IO.Compression.ZipFile]::ExtractToDirectory($uvZip,(Join-Path $temporary 'uv'))
    $uvSource = @(Get-ChildItem -LiteralPath (Join-Path $temporary 'uv') -Recurse -Filter uv.exe)[0].FullName
    Install-OwnedFile $uvSource $uv
  }
  Say 'Installing private Python…' '正在安装独立 Python…'
  $installed = $false
  if ($PythonMirror) {
    Say "Python from your mirror, $(Url-Host $PythonMirror)" "从你配置的镜像 $(Url-Host $PythonMirror) 下载 Python"
    $script:PythonFrom = $PythonMirror
    try { Invoke-Private $uv @('python','install',$PythonVersion,'--quiet'); $installed = $true } catch { Mirror-Failed $PythonMirror }
    $script:PythonFrom = $null
  }
  if (-not $installed) { Invoke-Private $uv @('python','install',$PythonVersion,'--quiet') }
  Say 'Downloading and verifying the Anagram release…' '正在下载并校验 Anagram 安装包…'
  $archive = Join-Path $temporary 'anagram.zip'; $checksum = $archive + '.sha256'
  Fetch ($ReleaseUrl.TrimEnd('/') + '/anagram.zip') $archive
  Fetch ($ReleaseUrl.TrimEnd('/') + '/anagram.zip.sha256') $checksum
  $expected = ((Get-Content -LiteralPath $checksum -Raw).Trim() -split '\s+')[0]
  if ($expected -cnotmatch '^[0-9a-f]{64}$' -or (Hash $archive) -ne $expected) { throw 'Release checksum mismatch.' }
  $signed = $null
  if (([Uri]$ReleaseUrl).Scheme -eq 'file') {
    Say 'A local release: checked by its checksum, not by a signature.' '本地安装包：只校验校验和，不校验签名。'
  } else {
    $bundle = $archive + '.sigstore.json'
    try { Fetch ($ReleaseUrl.TrimEnd('/') + '/anagram.zip.sigstore.json') $bundle } catch { throw 'The release carries no signature (anagram.zip.sigstore.json).' }
    $asked = if ($ReleaseUrl -match '/download/v([0-9]+\.[0-9]+\.[0-9]+)/?$') { $Matches[1] } else { '' }
    try { $signed = Release-Signature $archive $bundle $asked } catch { throw "The release is not signed by Anagram's release workflow; it was not installed." }
    Say "Signed by Anagram's release workflow for version $signed." "已由 Anagram 发布流程签名，版本 $signed。"
  }
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
  if ($signed -and (Get-Content -LiteralPath (Join-Path $release 'VERSION') -Raw).Trim() -ne $signed) { throw "The release's version is not the one its signature is for ($signed)." }
  # A release asked for by its version (the extension's own, from Settings) must be that version.
  if ($ReleaseUrl -match '/download/v([0-9]+\.[0-9]+\.[0-9]+)/?$') {
    $released = (Get-Content -LiteralPath (Join-Path $release 'VERSION') -Raw).Trim()
    if ($released -ne $Matches[1]) { throw "The release says it is $released, not $($Matches[1]) as asked." }
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
  Say 'Installing locked runtime packages…' '正在安装版本锁定的运行依赖…'
  Push-Location (Join-Path $ComponentHome 'app')
  # Pre-existing staging was refused before any writes. Only this transaction's
  # venv.next may be removed by failure cleanup.
  $createdVenv = $true
  $stagedVenv = Join-Path $ComponentHome 'venv.next'
  try {
    # uv sync --frozen fetches the lock's own files.pythonhosted.org addresses whatever index
    # is set, so from a mirror the lock is exported with its hashes and every one is required.
    $synced = $false
    if ($PypiIndex) {
      Say "Packages from your package index, $(Url-Host $PypiIndex)" "从你配置的软件包镜像 $(Url-Host $PypiIndex) 下载依赖"
      $requirements = Join-Path $temporary 'requirements.txt'
      try {
        Invoke-Private $uv @('export','--frozen','--no-dev','--no-emit-project','--no-header','--format','requirements-txt','--quiet','--output-file',$requirements)
        Invoke-Private $uv @('venv','--quiet','--python',$PythonVersion,$stagedVenv)
        Invoke-Private $uv @('pip','sync','--python',(Join-Path $stagedVenv 'Scripts\python.exe'),'--require-hashes','--no-build','--default-index',$PypiIndex,$requirements)
        $synced = $true
      } catch {
        Mirror-Failed $PypiIndex
        if (Test-Path -LiteralPath $stagedVenv) { Assert-Plain $stagedVenv $ComponentHome; Remove-Item -LiteralPath $stagedVenv -Recurse -Force }
      }
    }
    if (-not $synced) { Invoke-Private $uv @('sync','--frozen','--no-dev','--no-build','--python',$PythonVersion,'--quiet') }
  } finally { Pop-Location }
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
