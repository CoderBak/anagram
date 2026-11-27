# Windows-only isolated launcher/parser smoke. No real browser registry is touched.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
foreach ($file in @('install.ps1','installer\maintenance.ps1')) {
  $tokens=$null; $errors=$null
  $null=[Management.Automation.Language.Parser]::ParseFile((Join-Path $root $file),[ref]$tokens,[ref]$errors)
  if ($errors.Count) { throw ($errors | Out-String) }
}
& (Join-Path $PSScriptRoot 'windows-installer.ps1')
& (Join-Path $PSScriptRoot 'windows-uninstall.ps1')
$temporary=Join-Path ([IO.Path]::GetTempPath()) ('anagram-native-test-' + [Guid]::NewGuid().ToString('N'))
$component=Join-Path $temporary 'component with spaces'
try {
  $null=New-Item -ItemType Directory -Path (Join-Path $component 'app') -Force
  $null=New-Item -ItemType Directory -Path (Join-Path $component 'bin') -Force
  & python -m venv (Join-Path $component 'venv')
  if ($LASTEXITCODE -ne 0) { throw 'Temporary private Python creation failed' }
  @'
import json, struct, sys
assert sys.argv[1]=='--home' and sys.argv[3]=='chrome-extension://abcdefghijklmnopabcdefghijklmnop/'
n=struct.unpack('<I',sys.stdin.buffer.read(4))[0]
assert 0 < n < 1024, f'Invalid raw frame length: {n}'
request=json.loads(sys.stdin.buffer.read(n))
reply=json.dumps({'echo':request,'home':sys.argv[2]},ensure_ascii=False).encode()
sys.stdout.buffer.write(struct.pack('<I',len(reply))+reply);sys.stdout.buffer.flush()
'@ | Set-Content -LiteralPath (Join-Path $component 'app\native_host.py') -Encoding UTF8
  $compiler=Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  $launcher=Join-Path $component 'bin\anagram-native.exe'
  & $compiler /nologo /target:exe /optimize+ ("/out:"+$launcher) (Join-Path $root 'installer\NativeLauncher.cs')
  if ($LASTEXITCODE -ne 0) { throw 'C# launcher compile failed' }
  # Chromium sends binary frames with no text preamble and keeps its input pipe open.
  @'
import json, struct, subprocess, sys

launcher, home = sys.argv[1:]
request = {"id": "binary-frame", "text": "hello\n\u4e16\u754c"}
payload = json.dumps(request, ensure_ascii=False).encode("utf-8")
with subprocess.Popen([launcher, "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"],
                      stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as child:
    try:
        child.stdin.write(struct.pack("<I", len(payload)) + payload)
        child.stdin.flush()
        # The one-request host exits after its small reply, with stdin still open.
        assert child.wait(timeout=10) == 0, child.stderr.read()
        raw = child.stdout.read()
        assert len(raw) >= 4 and struct.unpack("<I", raw[:4])[0] == len(raw) - 4, "Invalid reply frame"
        assert json.loads(raw[4:]) == {"echo": request, "home": home}
    finally:
        child.stdin.close()
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
'@ | & python - $launcher $component
  if ($LASTEXITCODE -ne 0) { throw 'Native launcher frame check failed' }
  Write-Host 'PASS Windows PowerShell parsing, C# compilation, private-Python launcher, exact home argument, raw native framing'
} finally {
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force -Recurse }
}
