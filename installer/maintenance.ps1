# Fixed Windows maintenance worker. Only launched from the installed trusted helper.
param(
  [Parameter(Mandatory=$true)][ValidateSet('update','uninstall')][string]$Operation,
  [Parameter(Mandatory=$true)][string]$ComponentHome,
  [Parameter(Mandatory=$true)][int]$HostPid,
  [Parameter(Mandatory=$true)][string]$Receipt,
  [ValidateSet('en','zh_CN')][string]$Language = 'en'
)
$ErrorActionPreference = 'Stop'
$homeLock = $null
$exitCode = 1
# An unnamed, non-inheritable job owns this fixed worker and its descendants.
# Windows 8+ supports nested jobs; failure to establish one aborts before writes.
# https://learn.microsoft.com/windows/win32/procthread/job-objects
function Start-MaintenanceJob {
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class AnagramMaintenanceJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime; public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveLimit;
    public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic; public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long User, Kernel, PeriodUser, PeriodKernel;
    public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static IntPtr job;
  public static void Start() {
    job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception();
    var limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)) ||
        !AssignProcessToJobObject(job, GetCurrentProcess())) {
      int error = Marshal.GetLastWin32Error(); CloseHandle(job); job = IntPtr.Zero;
      throw new Win32Exception(error);
    }
    // Keep the only job handle until this process exits. Its closure terminates
    // any remaining descendant, including one whose immediate parent crashed.
  }
  public static bool ChildrenExited() {
    Accounting info;
    if (!QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero))
      throw new Win32Exception();
    return info.ActiveProcesses <= 1;
  }
}
'@
  [AnagramMaintenanceJob]::Start()
}
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
  Start-MaintenanceJob
  Say 'Waiting for the browser component to stop…' '正在等待浏览器本地组件退出…'
  $process = Get-Process -Id $HostPid -ErrorAction SilentlyContinue
  if ($process -and -not $process.WaitForExit(60000)) { throw 'Browser component did not stop. Close Anagram setup and retry.' }
  # The launcher may exit milliseconds after Python; bounded wait avoids an EXE lock race.
  Start-Sleep -Milliseconds 500
  $ComponentHome = Check-Home
  $lockPath = Join-Path $ComponentHome '.native-host.lock'
  if (Test-Path -LiteralPath $lockPath) {
    if ((Get-Item -LiteralPath $lockPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Native lock is a reparse point' }
  }
  # Same first-byte exclusive lock used by Python/filelock on Windows. Delete
  # sharing lets uninstall remove the retired tree while this handle remains held.
  $homeLock = [IO.FileStream]::new($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
  $homeLock.Lock(0,1)
  $null = Check-Home
  $python = Join-Path $ComponentHome 'venv\Scripts\python.exe'
  $helper = Join-Path $ComponentHome 'app\native_registration.py'
  if ($Operation -eq 'update') {
    Say 'Updating the local component…' '正在更新本地组件…'
    $planText = & $python -I $helper update --home $ComponentHome --worker
    if ($LASTEXITCODE -ne 0) { throw 'Component update preparation failed' }
    $plan = $planText | ConvertFrom-Json
    $installer = Join-Path $ComponentHome 'app\install.ps1'
    if ($plan.status -ne 'prepared' -or $plan.installer -ne $installer -or $plan.browser -notin @('chrome','firefox') -or $plan.language -notin @('en','zh_CN')) { throw 'Invalid fixed update plan' }
    if (($plan.browser -eq 'chrome' -and $plan.extension_id -cnotmatch '^[a-p]{32}$') -or ($plan.browser -eq 'firefox' -and $plan.extension_id -ne 'anagram@coderbak.dev')) { throw 'Invalid update extension ID' }
    if ((Get-Item -LiteralPath $installer -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installer is a reparse point' }
    # Stay in this process so the installer can validate and borrow the actual
    # locked FileStream. A flag/environment variable never bypasses its lock.
    & $installer -ComponentHome $ComponentHome -Browser $plan.browser -ExtensionId $plan.extension_id -Language $plan.language -MaintenanceLock $homeLock
  } else {
    Say 'Removing owned browser registrations and component files…' '正在移除属于 Anagram 的浏览器注册和组件文件…'
    & $python -I $helper unregister --home $ComponentHome
    if ($LASTEXITCODE -ne 0) { throw 'Native registration cleanup failed; component files were kept' }
    $null = Check-Home
    foreach ($item in Get-ChildItem -LiteralPath $ComponentHome -Force -Recurse) {
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing reparse point: $($item.FullName)" }
    }
    # Revoke startup authority before the lock pathname can disappear.
    Remove-Item -LiteralPath (Join-Path $ComponentHome '.native-component.json') -Force
    Remove-Item -LiteralPath $ComponentHome -Recurse -Force
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  while (-not [AnagramMaintenanceJob]::ChildrenExited()) {
    if ([DateTime]::UtcNow -ge $deadline) { throw 'A maintenance child process has not stopped; close this window before retrying.' }
    Start-Sleep -Milliseconds 50
  }
  $result = @{schema_version=1;operation=$Operation;status='completed';time=[DateTime]::UtcNow.ToString('o')}
  Save-Receipt $Receipt $result
  if ($Operation -eq 'update') {
    Save-Receipt (Join-Path $ComponentHome 'run\maintenance-receipt.json') $result
    Say 'Update complete. Return to Anagram and reconnect.' '更新完成。请返回 Anagram 并重新连接。'
  } else {
    Say 'Local component removed. You can now remove the Anagram browser extension.' '本地组件已移除。现在可以移除 Anagram 浏览器扩展。'
  }
  $exitCode = 0
} catch {
  Save-Receipt $Receipt @{schema_version=1;operation=$Operation;status='failed';error=$_.Exception.Message}
  Write-Host $_.Exception.Message -ForegroundColor Red
  Say 'Maintenance failed. Files may remain; see the message above.' '操作失败，可能仍有文件保留。请查看上方提示。'
} finally {
  # Never release ownership while a failed/abandoned descendant could still write.
  # On success every descendant has exited. On failure keep the lock through exit;
  # the job closes with this process and terminates its remaining process tree.
  if ($exitCode -eq 0 -and $homeLock) { $homeLock.Dispose(); $homeLock = $null }
  Say 'Press Enter to close this window.' '按 Enter 关闭此窗口。'
  $null = Read-Host
  [Environment]::Exit($exitCode)
}
