# Windows-only isolated launcher/parser smoke. No real browser registry is touched.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
foreach ($file in @('install.ps1','installer\maintenance.ps1')) {
  $tokens=$null; $errors=$null
  $null=[Management.Automation.Language.Parser]::ParseFile((Join-Path $root $file),[ref]$tokens,[ref]$errors)
  if ($errors.Count) { throw ($errors | Out-String) }
}
& (Join-Path $PSScriptRoot 'windows-installer.ps1')
$temporary=Join-Path ([IO.Path]::GetTempPath()) ('anagram-native-test-' + [Guid]::NewGuid().ToString('N'))
$component=Join-Path $temporary 'component with spaces'
$process=$null
try {
  $null=New-Item -ItemType Directory -Path (Join-Path $component 'app') -Force
  $null=New-Item -ItemType Directory -Path (Join-Path $component 'bin') -Force
  & python -m venv (Join-Path $component 'venv')
  if ($LASTEXITCODE -ne 0) { throw 'Temporary private Python creation failed' }
  @'
import sys
assert sys.argv[1] == 'prepare' and sys.argv[2] == '--home'
'@ | Set-Content -LiteralPath (Join-Path $component 'app\native_registration.py') -Encoding UTF8
  @'
import json, struct, sys
assert sys.argv[1]=='--home' and sys.argv[3]=='chrome-extension://abcdefghijklmnopabcdefghijklmnop/'
n=struct.unpack('<I',sys.stdin.buffer.read(4))[0]
request=json.loads(sys.stdin.buffer.read(n))
reply=json.dumps({'echo':request,'home':sys.argv[2]},ensure_ascii=False).encode()
sys.stdout.buffer.write(struct.pack('<I',len(reply))+reply);sys.stdout.buffer.flush()
'@ | Set-Content -LiteralPath (Join-Path $component 'app\native_host.py') -Encoding UTF8
  $compiler=Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  $launcher=Join-Path $component 'bin\anagram-native.exe'
  & $compiler /nologo /target:exe /optimize+ ("/out:"+$launcher) (Join-Path $root 'installer\NativeLauncher.cs')
  if ($LASTEXITCODE -ne 0) { throw 'C# launcher compile failed' }
  $start=New-Object Diagnostics.ProcessStartInfo
  $start.FileName=$launcher; $start.Arguments='chrome-extension://abcdefghijklmnopabcdefghijklmnop/'
  $start.UseShellExecute=$false; $start.RedirectStandardInput=$true; $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
  $process=[Diagnostics.Process]::Start($start)
  $bytes=[Text.Encoding]::UTF8.GetBytes('{"id":"binary-frame","text":"hello\nworld"}')
  $writer=New-Object IO.BinaryWriter($process.StandardInput.BaseStream)
  $writer.Write([uint32]$bytes.Length);$writer.Write($bytes);$writer.Flush()
  $reader=New-Object IO.BinaryReader($process.StandardOutput.BaseStream)
  $length=$reader.ReadUInt32()
  if ($length -gt 1048576) { throw 'Invalid native frame length' }
  $reply=[Text.Encoding]::UTF8.GetString($reader.ReadBytes($length)) | ConvertFrom-Json
  if ($reply.echo.id -ne 'binary-frame' -or $reply.echo.text -ne "hello`nworld" -or $reply.home -ne $component) { throw 'Native launcher corrupted a frame or argument' }
  $process.StandardInput.Close()
  if (-not $process.WaitForExit(10000) -or $process.ExitCode -ne 0) { throw ('Native launcher failed: ' + $process.StandardError.ReadToEnd()) }
  Write-Host 'PASS Windows PowerShell parsing, C# compilation, private-Python launcher, exact home argument, raw native framing'
} finally {
  if ($process -and -not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force -Recurse }
}
