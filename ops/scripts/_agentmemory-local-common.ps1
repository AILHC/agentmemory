$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$deployedAppCandidate = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$deployedRuntimeCandidate = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$script:AmFormalRoot = if ($env:AGENTMEMORY_RUNTIME_ROOT) {
  [System.IO.Path]::GetFullPath($env:AGENTMEMORY_RUNTIME_ROOT)
} elseif (Test-Path -LiteralPath (Join-Path $deployedAppCandidate 'DEPLOYMENT.json') -PathType Leaf) {
  $deployedRuntimeCandidate
} else {
  'F:\ai-runtime\agentmemory'
}
$script:AmFormalHome = Join-Path $script:AmFormalRoot 'home'
$script:AmFormalInstall = Join-Path $script:AmFormalRoot 'install'
$script:AmFormalConfig = Join-Path $script:AmFormalHome 'iii-config.yaml'
$script:AmFormalStatePath = (Join-Path $script:AmFormalHome 'data\state_store.db').Replace('\', '/')
$script:AmFormalStreamPath = (Join-Path $script:AmFormalHome 'data\stream_store').Replace('\', '/')
$script:AmAppCurrent = Join-Path $script:AmFormalRoot 'app\current'
$script:AmDeploymentLock = Join-Path $script:AmFormalRoot 'tmp\deploy-current.lock.json'
$script:AmIiiExe = Join-Path $script:AmFormalInstall 'bin\iii.exe'
$script:AmServiceName = 'agentmemory'
$script:AmFormalPorts = @(3111, 3112, 3113, 49134)
$script:AmDevRoot = if ($env:AGENTMEMORY_DEV_RUNTIME_ROOT) {
  [System.IO.Path]::GetFullPath($env:AGENTMEMORY_DEV_RUNTIME_ROOT)
} else {
  'F:\ai-runtime\agentmemory-dev'
}
$script:AmDevHome = Join-Path $script:AmDevRoot 'home'
$script:AmDevLogs = Join-Path $script:AmDevRoot 'logs'
$script:AmDevRun = Join-Path $script:AmDevRoot 'run'
$script:AmDevTmp = Join-Path $script:AmDevRoot 'tmp'
$script:AmDevConfig = Join-Path $script:AmDevRoot 'iii-config.yaml'
$script:AmDevStatePath = (Join-Path $script:AmDevHome 'data\state_store.db').Replace('\', '/')
$script:AmDevStreamPath = (Join-Path $script:AmDevHome 'data\stream_store').Replace('\', '/')
$script:AmDevApp = if (Test-Path -LiteralPath (Join-Path $deployedAppCandidate 'DEPLOYMENT.json') -PathType Leaf) {
  $deployedAppCandidate
} else {
  [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
}
$script:AmDevPorts = @(3211, 3212, 3213, 49234)
$script:AmLastRuntimeConfigOk = $false
$script:AmLastDeploymentManifestOk = $false

function Get-AmFullPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  return [System.IO.Path]::GetFullPath($Path)
}

function Test-AmSamePath {
  param(
    [Parameter(Mandatory = $true)][string]$Left,
    [Parameter(Mandatory = $true)][string]$Right
  )
  return [string]::Equals((Get-AmFullPath $Left), (Get-AmFullPath $Right), [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-AmPathInside {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Root
  )
  $fullPath = Get-AmFullPath $Path
  $fullRoot = Get-AmFullPath $Root
  if (-not $fullRoot.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
    $fullRoot = $fullRoot + [System.IO.Path]::DirectorySeparatorChar
  }
  return $fullPath.StartsWith($fullRoot, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-AmPathInside {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Name
  )
  if (-not (Test-AmPathInside -Path $Path -Root $Root)) {
    throw "$Name path guard failed: '$Path' is not under '$Root'."
  }
}

function Assert-AmPathEquals {
  param(
    [Parameter(Mandatory = $true)][string]$Actual,
    [Parameter(Mandatory = $true)][string]$Expected,
    [Parameter(Mandatory = $true)][string]$Name
  )
  if (-not (Test-AmSamePath -Left $Actual -Right $Expected)) {
    throw "$Name must be '$Expected', got '$Actual'."
  }
}

function Assert-AmNoDeploymentInProgress {
  if (Test-Path -LiteralPath $script:AmDeploymentLock -PathType Leaf) {
    throw "Refusing start: AgentMemory deployment lock exists at '$script:AmDeploymentLock'."
  }
}

if (-not ('AgentMemory.ServiceSnapshotNative' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace AgentMemory {
  public sealed class ServiceSnapshotRecord {
    public string QueryState { get; set; }
    public string Name { get; set; }
    public string State { get; set; }
    public int ProcessId { get; set; }
    public int ErrorCode { get; set; }
  }

  public static class ServiceSnapshotNative {
    private const uint ScManagerConnect = 0x0001;
    private const uint ServiceQueryStatus = 0x0004;
    private const int ErrorServiceDoesNotExist = 1060;

    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceStatusProcess {
      public uint ServiceType;
      public uint CurrentState;
      public uint ControlsAccepted;
      public uint Win32ExitCode;
      public uint ServiceSpecificExitCode;
      public uint CheckPoint;
      public uint WaitHint;
      public uint ProcessId;
      public uint ServiceFlags;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenSCManager(
      string machineName,
      string databaseName,
      uint desiredAccess
    );

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenService(
      IntPtr serviceManager,
      string serviceName,
      uint desiredAccess
    );

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool QueryServiceStatusEx(
      IntPtr service,
      int informationLevel,
      out ServiceStatusProcess buffer,
      int bufferSize,
      out int bytesNeeded
    );

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool CloseServiceHandle(IntPtr handle);

    public static ServiceSnapshotRecord Query(string serviceName) {
      IntPtr manager = OpenSCManager(null, null, ScManagerConnect);
      if (manager == IntPtr.Zero) return Failed(serviceName, Marshal.GetLastWin32Error());
      try {
        IntPtr service = OpenService(manager, serviceName, ServiceQueryStatus);
        if (service == IntPtr.Zero) {
          int error = Marshal.GetLastWin32Error();
          return error == ErrorServiceDoesNotExist
            ? new ServiceSnapshotRecord {
                QueryState = "absent",
                Name = serviceName,
                State = "Absent",
                ProcessId = 0,
                ErrorCode = error
              }
            : Failed(serviceName, error);
        }
        try {
          ServiceStatusProcess status;
          int bytesNeeded;
          if (!QueryServiceStatusEx(
              service,
              0,
              out status,
              Marshal.SizeOf(typeof(ServiceStatusProcess)),
              out bytesNeeded)) {
            return Failed(serviceName, Marshal.GetLastWin32Error());
          }
          return new ServiceSnapshotRecord {
            QueryState = "present",
            Name = serviceName,
            State = StateName(status.CurrentState),
            ProcessId = checked((int)status.ProcessId),
            ErrorCode = 0
          };
        } finally {
          CloseServiceHandle(service);
        }
      } finally {
        CloseServiceHandle(manager);
      }
    }

    private static ServiceSnapshotRecord Failed(string serviceName, int errorCode) {
      return new ServiceSnapshotRecord {
        QueryState = "query_failed",
        Name = serviceName,
        State = "Unknown",
        ProcessId = 0,
        ErrorCode = errorCode
      };
    }

    private static string StateName(uint state) {
      switch (state) {
        case 1: return "Stopped";
        case 2: return "StartPending";
        case 3: return "StopPending";
        case 4: return "Running";
        case 5: return "ContinuePending";
        case 6: return "PausePending";
        case 7: return "Paused";
        default: return "Unknown";
      }
    }
  }
}
'@
}

function Get-AmServiceQuery {
  try {
    return [AgentMemory.ServiceSnapshotNative]::Query($script:AmServiceName)
  } catch {
    return [pscustomobject]@{
      QueryState = 'query_failed'
      Name = $script:AmServiceName
      State = 'Unknown'
      ProcessId = 0
      ErrorCode = 0
    }
  }
}

function Get-AmService {
  $query = Get-AmServiceQuery
  if ($query.QueryState -eq 'query_failed') {
    throw 'AgentMemory service query backend failed.'
  }
  if ($query.QueryState -eq 'absent') {
    return $null
  }
  return $query
}

if (-not ('AgentMemory.ProcessSnapshotNative' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace AgentMemory {
  public sealed class ProcessSnapshotRecord {
    public int ProcessId { get; set; }
    public int ParentProcessId { get; set; }
    public string Name { get; set; }
    public string ExecutablePath { get; set; }
    public string CommandLine { get; set; }
    public DateTime CreationDate { get; set; }
  }

  public static class ProcessSnapshotNative {
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const int ProcessBasicInformation = 0;
    private const int ProcessCommandLineInformation = 60;

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicInformation {
      public IntPtr Reserved1;
      public IntPtr PebBaseAddress;
      public IntPtr Reserved2_0;
      public IntPtr Reserved2_1;
      public IntPtr UniqueProcessId;
      public IntPtr InheritedFromUniqueProcessId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct UnicodeString {
      public ushort Length;
      public ushort MaximumLength;
      public IntPtr Buffer;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageName(
      IntPtr process,
      int flags,
      StringBuilder executablePath,
      ref int size
    );

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
      IntPtr process,
      int informationClass,
      IntPtr information,
      int informationLength,
      out int returnLength
    );

    public static ProcessSnapshotRecord[] Capture() {
      List<ProcessSnapshotRecord> records = new List<ProcessSnapshotRecord>();
      foreach (Process process in Process.GetProcesses()) {
        try {
          ProcessSnapshotRecord record = new ProcessSnapshotRecord();
          record.ProcessId = process.Id;
          record.ParentProcessId = 0;
          record.Name = GetProcessName(process);
          record.ExecutablePath = String.Empty;
          record.CommandLine = String.Empty;
          record.CreationDate = GetStartTime(process);

          IntPtr handle = OpenProcess(ProcessQueryLimitedInformation, false, process.Id);
          if (handle != IntPtr.Zero) {
            try {
              record.ParentProcessId = GetParentProcessId(handle);
              record.ExecutablePath = GetExecutablePath(handle);
              record.CommandLine = GetCommandLine(handle);
            } finally {
              CloseHandle(handle);
            }
          }
          records.Add(record);
        } catch {
          // Processes can exit while the snapshot is being built.
        } finally {
          process.Dispose();
        }
      }
      return records.ToArray();
    }

    private static string GetProcessName(Process process) {
      string name = process.ProcessName;
      return name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? name : name + ".exe";
    }

    private static DateTime GetStartTime(Process process) {
      try {
        return process.StartTime;
      } catch {
        return DateTime.MinValue;
      }
    }

    private static int GetParentProcessId(IntPtr handle) {
      int size = Marshal.SizeOf(typeof(BasicInformation));
      IntPtr buffer = Marshal.AllocHGlobal(size);
      try {
        int returned;
        int status = NtQueryInformationProcess(handle, ProcessBasicInformation, buffer, size, out returned);
        if (status != 0) {
          return 0;
        }
        BasicInformation information =
          (BasicInformation)Marshal.PtrToStructure(buffer, typeof(BasicInformation));
        return information.InheritedFromUniqueProcessId.ToInt32();
      } finally {
        Marshal.FreeHGlobal(buffer);
      }
    }

    private static string GetExecutablePath(IntPtr handle) {
      int capacity = 32768;
      StringBuilder path = new StringBuilder(capacity);
      return QueryFullProcessImageName(handle, 0, path, ref capacity) ? path.ToString() : String.Empty;
    }

    private static string GetCommandLine(IntPtr handle) {
      int required;
      NtQueryInformationProcess(handle, ProcessCommandLineInformation, IntPtr.Zero, 0, out required);
      if (required <= 0) {
        return String.Empty;
      }

      IntPtr buffer = Marshal.AllocHGlobal(required);
      try {
        int returned;
        int status =
          NtQueryInformationProcess(handle, ProcessCommandLineInformation, buffer, required, out returned);
        if (status != 0) {
          return String.Empty;
        }
        UnicodeString commandLine =
          (UnicodeString)Marshal.PtrToStructure(buffer, typeof(UnicodeString));
        if (commandLine.Buffer == IntPtr.Zero || commandLine.Length == 0) {
          return String.Empty;
        }
        return Marshal.PtrToStringUni(commandLine.Buffer, commandLine.Length / 2);
      } finally {
        Marshal.FreeHGlobal(buffer);
      }
    }
  }
}
'@
}

function Get-AmProcesses {
  return @([AgentMemory.ProcessSnapshotNative]::Capture() | Where-Object { $null -ne $_ })
}

function Get-AmProcessById {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [array]$AllProcesses = @()
  )
  if ($AllProcesses.Count -eq 0) {
    $AllProcesses = Get-AmProcesses
  }
  return $AllProcesses | Where-Object { [int]$_.ProcessId -eq $ProcessId } | Select-Object -First 1
}

function Get-AmListeners {
  param([Parameter(Mandatory = $true)][int[]]$Ports)
  $wanted = New-Object 'System.Collections.Generic.HashSet[int]'
  foreach ($port in $Ports) {
    [void]$wanted.Add([int]$port)
  }
  $listeners = @()
  foreach ($line in @(& "$env:SystemRoot\System32\netstat.exe" -ano -p tcp 2>$null)) {
    if ($line -notmatch '^\s*TCP\s+(.+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$') {
      continue
    }
    $port = [int]$Matches[2]
    if (-not $wanted.Contains($port)) {
      continue
    }
    $listeners += [pscustomobject]@{
      LocalAddress = [string]$Matches[1]
      LocalPort = $port
      OwningProcess = [int]$Matches[3]
      State = 'Listen'
    }
  }
  return @($listeners)
}

function Get-AmPortOwnerIds {
  param([Parameter(Mandatory = $true)][int[]]$Ports)
  $listeners = @(Get-AmListeners -Ports $Ports)
  $ids = New-Object 'System.Collections.Generic.HashSet[int]'
  foreach ($listener in $listeners) {
    [void]$ids.Add([int]$listener.OwningProcess)
  }
  return @($ids)
}

function Get-AmAncestorIds {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [array]$AllProcesses
  )
  $ids = New-Object 'System.Collections.Generic.List[int]'
  $current = Get-AmProcessById -ProcessId $ProcessId -AllProcesses $AllProcesses
  $guard = 0
  while ($current -and $current.ParentProcessId -and $guard -lt 64) {
    $parentId = [int]$current.ParentProcessId
    [void]$ids.Add($parentId)
    $current = Get-AmProcessById -ProcessId $parentId -AllProcesses $AllProcesses
    $guard++
  }
  return @($ids)
}

function Get-AmDescendantIds {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [array]$AllProcesses
  )
  $result = New-Object 'System.Collections.Generic.HashSet[int]'
  $queue = New-Object 'System.Collections.Generic.Queue[int]'
  $queue.Enqueue($ProcessId)
  while ($queue.Count -gt 0) {
    $parent = $queue.Dequeue()
    $children = @($AllProcesses | Where-Object { $_.ParentProcessId -and [int]$_.ParentProcessId -eq $parent })
    foreach ($child in $children) {
      $childId = [int]$child.ProcessId
      if ($result.Add($childId)) {
        $queue.Enqueue($childId)
      }
    }
  }
  return @($result)
}

function Test-AmUnderProcessTree {
  param(
    [Parameter(Mandatory = $true)][int]$TargetProcessId,
    [Parameter(Mandatory = $true)][int]$RootProcessId,
    [array]$AllProcesses
  )
  if ($RootProcessId -le 0) { return $false }
  if ($TargetProcessId -eq $RootProcessId) { return $true }
  $ancestors = Get-AmAncestorIds -ProcessId $TargetProcessId -AllProcesses $AllProcesses
  return $ancestors -contains $RootProcessId
}

function Test-AmTextContains {
  param(
    [AllowNull()][string]$Text,
    [Parameter(Mandatory = $true)][string]$Needle
  )
  if ([string]::IsNullOrEmpty($Text)) { return $false }
  return $Text.IndexOf($Needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

if (-not ('AgentMemory.CommandLineNative' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace AgentMemory {
  public static class CommandLineNative {
    [DllImport("shell32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CommandLineToArgvW(string commandLine, out int argumentCount);
    [DllImport("kernel32.dll")]
    public static extern IntPtr LocalFree(IntPtr memory);
  }
}
'@
}

function ConvertFrom-AmWindowsCommandLine {
  param([AllowNull()][string]$CommandLine)
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return @() }
  $count = 0
  $pointer = [AgentMemory.CommandLineNative]::CommandLineToArgvW($CommandLine, [ref]$count)
  if ($pointer -eq [IntPtr]::Zero -or $count -le 0) { return @() }
  try {
    $arguments = New-Object 'System.Collections.Generic.List[string]'
    for ($index = 0; $index -lt $count; $index++) {
      $argumentPointer = [Runtime.InteropServices.Marshal]::ReadIntPtr($pointer, $index * [IntPtr]::Size)
      [void]$arguments.Add([Runtime.InteropServices.Marshal]::PtrToStringUni($argumentPointer))
    }
    return @($arguments)
  } finally {
    [void][AgentMemory.CommandLineNative]::LocalFree($pointer)
  }
}

function Test-AmExactPathArgument {
  param(
    [AllowNull()][string]$Actual,
    [Parameter(Mandatory = $true)][string]$Expected
  )
  if ([string]::IsNullOrWhiteSpace($Actual)) { return $false }
  try { return Test-AmSamePath -Left $Actual -Right $Expected } catch { return $false }
}

function Test-AmExecutableArgument {
  param(
    [AllowNull()][string]$Argument,
    [Parameter(Mandatory = $true)][string]$ExecutablePath
  )
  if ([string]::IsNullOrWhiteSpace($Argument)) { return $false }
  if (Test-AmExactPathArgument -Actual $Argument -Expected $ExecutablePath) { return $true }
  $argumentName = [System.IO.Path]::GetFileName($Argument)
  $executableName = [System.IO.Path]::GetFileName($ExecutablePath)
  if ([string]::Equals($argumentName, $executableName, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
  return -not [System.IO.Path]::GetExtension($argumentName) -and
    [string]::Equals($argumentName, [System.IO.Path]::GetFileNameWithoutExtension($executableName), [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-AmPathStartsWith {
  param(
    [AllowNull()][string]$Path,
    [Parameter(Mandatory = $true)][string]$Root
  )
  if ([string]::IsNullOrEmpty($Path)) { return $false }
  $fullPath = Get-AmFullPath $Path
  $fullRoot = Get-AmFullPath $Root
  if ([string]::Equals($fullPath, $fullRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $true
  }
  if (-not $fullRoot.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
    $fullRoot = $fullRoot + [System.IO.Path]::DirectorySeparatorChar
  }
  return $fullPath.StartsWith($fullRoot, [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-AmFormalIiiProcess {
  param(
    [Parameter(Mandatory = $true)]$Process
  )
  $path = [string]$Process.ExecutablePath
  if ([string]::IsNullOrWhiteSpace($path)) { return $false }
  if (-not (Test-AmSamePath -Left $path -Right $script:AmIiiExe)) { return $false }
  $arguments = @(ConvertFrom-AmWindowsCommandLine -CommandLine ([string]$Process.CommandLine))
  return $arguments.Count -eq 3 -and
    (Test-AmExecutableArgument -Argument $arguments[0] -ExecutablePath $path) -and
    $arguments[1] -ceq '--config' -and
    (Test-AmExactPathArgument -Actual $arguments[2] -Expected $script:AmFormalConfig)
}

function Test-AmFormalConsoleProcess {
  param(
    [Parameter(Mandatory = $true)]$Process,
    [array]$AllProcesses = @(),
    [int]$ServiceProcessId = 0
  )
  if (-not (Test-AmFormalIiiProcess -Process $Process)) { return $false }
  $pidValue = [int]$Process.ProcessId
  if ($ServiceProcessId -gt 0 -and (Test-AmUnderProcessTree -TargetProcessId $pidValue -RootProcessId $ServiceProcessId -AllProcesses $AllProcesses)) {
    return $false
  }
  $path = [string]$Process.ExecutablePath
  if (Test-AmPathStartsWith -Path $path -Root (Join-Path $script:AmFormalRoot 'service')) {
    return $false
  }
  return $true
}

function Test-AmDevProcess {
  param([Parameter(Mandatory = $true)]$Process)
  $path = [string]$Process.ExecutablePath
  if ([string]::IsNullOrWhiteSpace($path)) { return $false }
  if (-not (Test-AmSamePath -Left $path -Right $script:AmIiiExe)) { return $false }
  $arguments = @(ConvertFrom-AmWindowsCommandLine -CommandLine ([string]$Process.CommandLine))
  return $arguments.Count -eq 3 -and
    (Test-AmExecutableArgument -Argument $arguments[0] -ExecutablePath $path) -and
    $arguments[1] -ceq '--config' -and
    (Test-AmExactPathArgument -Actual $arguments[2] -Expected $script:AmDevConfig)
}

function Get-AmVerifiedFormalConsoleRootId {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [array]$AllProcesses,
    [int]$ServiceProcessId = 0
  )
  $proc = Get-AmProcessById -ProcessId $ProcessId -AllProcesses $AllProcesses
  if ($proc -and (Test-AmFormalConsoleProcess -Process $proc -AllProcesses $AllProcesses -ServiceProcessId $ServiceProcessId)) {
    return $ProcessId
  }
  foreach ($ancestorId in Get-AmAncestorIds -ProcessId $ProcessId -AllProcesses $AllProcesses) {
    $ancestor = Get-AmProcessById -ProcessId ([int]$ancestorId) -AllProcesses $AllProcesses
    if ($ancestor -and (Test-AmFormalConsoleProcess -Process $ancestor -AllProcesses $AllProcesses -ServiceProcessId $ServiceProcessId)) {
      return [int]$ancestorId
    }
  }
  return $null
}

function Get-AmVerifiedDevRootId {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [array]$AllProcesses
  )
  $proc = Get-AmProcessById -ProcessId $ProcessId -AllProcesses $AllProcesses
  if ($proc -and (Test-AmDevProcess -Process $proc)) {
    return $ProcessId
  }
  foreach ($ancestorId in Get-AmAncestorIds -ProcessId $ProcessId -AllProcesses $AllProcesses) {
    $ancestor = Get-AmProcessById -ProcessId ([int]$ancestorId) -AllProcesses $AllProcesses
    if ($ancestor -and (Test-AmDevProcess -Process $ancestor)) {
      return [int]$ancestorId
    }
  }
  return $null
}

function Assert-AmRequiredFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Name
  )
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Name is missing: $Path"
  }
}

function Assert-AmRequiredDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Name
  )
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "$Name is missing: $Path"
  }
}

function Get-AmWorkerPortFromConfig {
  param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [Parameter(Mandatory = $true)][string]$WorkerName
  )
  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { return $null }
  $inside = $false
  foreach ($line in Get-Content -LiteralPath $ConfigPath) {
    if ($line -match '^\s*-\s+name:\s*(.+?)\s*$') {
      $inside = ([string]$Matches[1]) -eq $WorkerName
      continue
    }
    if ($inside -and $line -match '^\s*port:\s*(\d+)\s*$') {
      return [int]$Matches[1]
    }
  }
  return $null
}

function Test-AmConfigContainsText {
  param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [Parameter(Mandatory = $true)][string]$Text
  )
  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { return $false }
  return [bool](Select-String -LiteralPath $ConfigPath -SimpleMatch -Pattern $Text -Quiet)
}

function Write-AmPortReport {
  param(
    [Parameter(Mandatory = $true)][int[]]$Ports,
    [array]$Listeners,
    [array]$AllProcesses,
    [int]$ServiceProcessId = 0
  )
  foreach ($port in $Ports) {
    $matches = @($Listeners | Where-Object { [int]$_.LocalPort -eq $port })
    if ($matches.Count -eq 0) {
      Write-Output "port.$port=closed"
      continue
    }
    foreach ($listener in $matches) {
      $ownerId = [int]$listener.OwningProcess
      $proc = Get-AmProcessById -ProcessId $ownerId -AllProcesses $AllProcesses
      $name = if ($proc) { [string]$proc.Name } else { 'unknown' }
      $underService = if ($ServiceProcessId -gt 0) { Test-AmUnderProcessTree -TargetProcessId $ownerId -RootProcessId $ServiceProcessId -AllProcesses $AllProcesses } else { $false }
      Write-Output "port.$port=listen pid=$ownerId name=$name serviceTree=$underService"
    }
  }
}

function Wait-AmPortsClosed {
  param(
    [Parameter(Mandatory = $true)][int[]]$Ports,
    [int]$TimeoutSeconds = 10
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $open = @(Get-AmListeners -Ports $Ports)
    if ($open.Count -eq 0) { return $true }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Read-AmPidFile {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  $raw = (Get-Content -LiteralPath $Path -Raw).Trim()
  $pidValue = 0
  if ([int]::TryParse($raw, [ref]$pidValue) -and $pidValue -gt 0) {
    return $pidValue
  }
  return $null
}

function Stop-AmVerifiedProcessTree {
  param(
    [Parameter(Mandatory = $true)][int]$RootProcessId,
    [array]$AllProcesses
  )
  $ids = New-Object 'System.Collections.Generic.List[int]'
  foreach ($childId in Get-AmDescendantIds -ProcessId $RootProcessId -AllProcesses $AllProcesses) {
    [void]$ids.Add([int]$childId)
  }
  [void]$ids.Add($RootProcessId)
  foreach ($id in ($ids | Select-Object -Unique | Sort-Object -Descending)) {
    $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($proc) {
      Write-Output "stopping.pid=$id"
      Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
    }
  }
}

function Write-AmRuntimeConfigSummary {
  param([Parameter(Mandatory = $true)][string]$BaseUrl)
  $script:AmLastRuntimeConfigOk = $false
  try {
    $runtimeConfig = Invoke-RestMethod -Uri "$BaseUrl/agentmemory/runtime-config/diagnostics" -TimeoutSec 5 -ErrorAction Stop
  } catch {
    Write-Output "runtimeConfig.status=unavailable"
    Write-Output "runtimeConfig.error=$($_.Exception.Message)"
    return
  }

  $runtime = $runtimeConfig
  $runtimeProperty = $runtimeConfig.PSObject.Properties['runtime']
  if ($runtimeProperty -and $null -ne $runtimeProperty.Value) {
    $runtime = $runtimeProperty.Value
  }

  Write-Output 'runtimeConfig.status=ok'
  $outputLanguageConfigured = $runtime.PSObject.Properties['outputLanguageConfigured']
  if ($outputLanguageConfigured) {
    Write-Output "runtimeConfig.outputLanguageConfigured=$($outputLanguageConfigured.Value)"
  }
  $outputLanguage = $runtime.PSObject.Properties['outputLanguage']
  if ($outputLanguage) {
    Write-Output "runtimeConfig.outputLanguage=$($outputLanguage.Value)"
  }
  $modelRoutingProperty = $runtime.PSObject.Properties['modelRouting']
  if ($modelRoutingProperty -and $null -ne $modelRoutingProperty.Value) {
    $modelRouting = $modelRoutingProperty.Value
    $stages = @($modelRouting.PSObject.Properties | ForEach-Object { $_.Name })
    Write-Output "runtimeConfig.modelRoutingStages=$($stages.Count)"
    foreach ($prop in $modelRouting.PSObject.Properties) {
      $value = $prop.Value
      $modelProperty = $value.PSObject.Properties['model']
      $sourceProperty = $value.PSObject.Properties['source']
      $providerProperty = $value.PSObject.Properties['provider']
      $modelAppliedProperty = $value.PSObject.Properties['modelApplied']
      $model = if ($modelProperty) { $modelProperty.Value } else { '' }
      $source = if ($sourceProperty) { $sourceProperty.Value } else { '' }
      $provider = if ($providerProperty) { $providerProperty.Value } else { '' }
      $modelApplied = if ($modelAppliedProperty) { $modelAppliedProperty.Value } else { '' }
      Write-Output "runtimeConfig.modelRouting.$($prop.Name)=model:$model source:$source provider:$provider modelApplied:$modelApplied"
    }
  }
  $script:AmLastRuntimeConfigOk = $true
}

function Read-AmJsonFile {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try {
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -ErrorAction Stop
  } catch {
    return $null
  }
}

function Get-AmFileSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  $stream = [System.IO.File]::OpenRead($Path)
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $algorithm.ComputeHash($stream)
    return ([System.BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
}

function Write-AmDeploymentManifestSummary {
  param([Parameter(Mandatory = $true)][string]$AppDirectory)
  $script:AmLastDeploymentManifestOk = $false
  $manifestPath = Join-Path $AppDirectory 'DEPLOYMENT.json'
  $manifest = Read-AmJsonFile -Path $manifestPath
  if (-not $manifest) {
    Write-Output 'deployment.manifest=missing_or_invalid'
    return
  }
  if ([int]$manifest.schemaVersion -ne 3) {
    Write-Output "deployment.schemaVersion=$($manifest.schemaVersion)"
    Write-Output 'deployment.manifest=unsupported'
    return
  }
  $hasContent = $null -ne $manifest.PSObject.Properties['content']
  $hasKeyFiles = $null -ne $manifest.PSObject.Properties['keyFiles']
  if ([string]$manifest.sourceCommit -notmatch '^[0-9a-f]{40}$' -or
      -not $hasContent -or
      [string]$manifest.content.sha256 -notmatch '^[0-9a-f]{64}$' -or
      -not $hasKeyFiles -or
      -not ($manifest.keyFiles -is [array])) {
    Write-Output 'deployment.manifest=invalid'
    return
  }

  $packagePath = Join-Path $AppDirectory 'package.json'
  $package = Read-AmJsonFile -Path $packagePath
  if (-not $package -or [string]$package.version -cne [string]$manifest.packageVersion) {
    Write-Output 'deployment.packageVersion=bad'
    return
  }

  $requiredFiles = @(
    'dist/index.mjs',
    'dist/worker-supervisor.mjs',
    'scripts/_agentmemory-local-common.ps1',
    'scripts/agentmemory-deployment-manifest.mjs',
    'scripts/doctor-agentmemory-console.ps1',
    'scripts/doctor-agentmemory.ps1',
    'scripts/run-agentmemory-full-extraction.mjs',
    'scripts/start-agentmemory-console.ps1',
    'scripts/start-agentmemory.ps1',
    'scripts/stop-agentmemory-console.ps1',
    'scripts/stop-agentmemory-service-hook.ps1',
    'scripts/stop-agentmemory.ps1',
    'scripts/validate-agentmemory-worker-supervision.mjs'
  )
  foreach ($relativePath in $requiredFiles) {
    $entry = @($manifest.keyFiles | Where-Object { [string]$_.path -ceq $relativePath })
    if ($entry.Count -ne 1) {
      Write-Output "deployment.keyFile=$relativePath missing_from_manifest"
      return
    }
    $filePath = Join-Path $AppDirectory ($relativePath.Replace('/', '\'))
    if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
      Write-Output "deployment.keyFile=$relativePath missing"
      return
    }
    $file = Get-Item -LiteralPath $filePath
    $hash = Get-AmFileSha256 -Path $filePath
    if ([int64]$entry[0].size -ne [int64]$file.Length -or
        [string]$entry[0].sha256 -cne $hash) {
      Write-Output "deployment.keyFile=$relativePath hash_mismatch"
      return
    }
  }

  Write-Output 'deployment.manifest=ok'
  Write-Output "deployment.sourceCommit=$($manifest.sourceCommit)"
  Write-Output "deployment.packageVersion=$($manifest.packageVersion)"
  Write-Output "deployment.builtAt=$($manifest.builtAt)"
  $script:AmLastDeploymentManifestOk = $true
}

function Get-AmJsonInteger {
  param(
    [AllowNull()]$Value,
    [string[]]$Names
  )
  if ($null -eq $Value) { return 0 }
  foreach ($name in $Names) {
    $property = $Value.PSObject.Properties[$name]
    if (-not $property) { continue }
    $number = 0
    if ([int]::TryParse([string]$property.Value, [ref]$number) -and $number -gt 0) {
      return $number
    }
  }
  return 0
}

function Get-AmJsonString {
  param(
    [AllowNull()]$Value,
    [string[]]$Names
  )
  if ($null -eq $Value) { return '' }
  foreach ($name in $Names) {
    $property = $Value.PSObject.Properties[$name]
    if ($property -and -not [string]::IsNullOrWhiteSpace([string]$property.Value)) {
      if ($property.Value -is [DateTime]) {
        return ([DateTime]$property.Value).ToUniversalTime().ToString('o')
      }
      return [string]$property.Value
    }
  }
  return ''
}

function Test-AmNodeProcess {
  param([Parameter(Mandatory = $true)]$Process)
  $name = [string]$Process.Name
  $path = [string]$Process.ExecutablePath
  if ([string]::IsNullOrWhiteSpace($path)) { return $false }
  return [string]::Equals($name, 'node.exe', [System.StringComparison]::OrdinalIgnoreCase) -and
    [string]::Equals([System.IO.Path]::GetFileName($path), 'node.exe', [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-AmSupervisorArguments {
  param(
    [string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$NodeExecutablePath,
    [Parameter(Mandatory = $true)][string]$InstanceId,
    [Parameter(Mandatory = $true)][string]$AppDirectory
  )
  $supervisorEntry = Join-Path $AppDirectory 'dist\worker-supervisor.mjs'
  $workerEntry = Join-Path $AppDirectory 'dist\index.mjs'
  return $Arguments.Count -eq 6 -and
    (Test-AmExecutableArgument -Argument $Arguments[0] -ExecutablePath $NodeExecutablePath) -and
    (Test-AmExactPathArgument -Actual $Arguments[1] -Expected $supervisorEntry) -and
    $Arguments[2] -ceq '--instance-id' -and
    $Arguments[3] -ceq $InstanceId -and
    $Arguments[4] -ceq '--worker-entry' -and
    (Test-AmExactPathArgument -Actual $Arguments[5] -Expected $workerEntry)
}

function Test-AmSupervisorProcess {
  param(
    [Parameter(Mandatory = $true)]$Process,
    [Parameter(Mandatory = $true)][string]$InstanceId,
    [Parameter(Mandatory = $true)][string]$AppDirectory
  )
  if (-not (Test-AmNodeProcess -Process $Process)) { return $false }
  $arguments = @(ConvertFrom-AmWindowsCommandLine -CommandLine ([string]$Process.CommandLine))
  return Test-AmSupervisorArguments -Arguments $arguments -NodeExecutablePath ([string]$Process.ExecutablePath) -InstanceId $InstanceId -AppDirectory $AppDirectory
}

function Test-AmSupervisorCommandHostProcess {
  param(
    [Parameter(Mandatory = $true)]$Process,
    [Parameter(Mandatory = $true)][string]$InstanceId,
    [Parameter(Mandatory = $true)][string]$AppDirectory
  )
  if (-not [string]::Equals([string]$Process.Name, 'cmd.exe', [System.StringComparison]::OrdinalIgnoreCase)) {
    return $false
  }
  $path = [string]$Process.ExecutablePath
  $expectedCmd = Join-Path ([Environment]::GetFolderPath('System')) 'cmd.exe'
  if (-not (Test-AmExactPathArgument -Actual $path -Expected $expectedCmd)) { return $false }
  $arguments = @(ConvertFrom-AmWindowsCommandLine -CommandLine ([string]$Process.CommandLine))
  if ($arguments.Count -lt 3 -or -not (Test-AmExecutableArgument -Argument $arguments[0] -ExecutablePath $path)) { return $false }
  $commandIndex = -1
  for ($index = 1; $index -lt $arguments.Count; $index++) {
    if ([string]::Equals($arguments[$index], '/c', [System.StringComparison]::OrdinalIgnoreCase)) {
      $commandIndex = $index
      break
    }
    if (-not @('/d', '/s', '/q') -contains $arguments[$index].ToLowerInvariant()) { return $false }
  }
  if ($commandIndex -lt 1 -or $commandIndex -ge ($arguments.Count - 1)) { return $false }
  $nested = @($arguments[($commandIndex + 1)..($arguments.Count - 1)])
  if ($nested.Count -eq 1) {
    $nested = @(ConvertFrom-AmWindowsCommandLine -CommandLine $nested[0])
  }
  $nodePath = ''
  if ($nested.Count -gt 0) {
    $nodeCommand = Get-Command $nested[0] -ErrorAction SilentlyContinue
    if ($nodeCommand) { $nodePath = [string]$nodeCommand.Source }
  }
  if ([string]::IsNullOrWhiteSpace($nodePath)) { return $false }
  return Test-AmSupervisorArguments -Arguments $nested -NodeExecutablePath $nodePath -InstanceId $InstanceId -AppDirectory $AppDirectory
}

function Test-AmWorkerProcess {
  param(
    [Parameter(Mandatory = $true)]$Process,
    [Parameter(Mandatory = $true)][string]$AppDirectory
  )
  if (-not (Test-AmNodeProcess -Process $Process)) { return $false }
  $arguments = @(ConvertFrom-AmWindowsCommandLine -CommandLine ([string]$Process.CommandLine))
  return $arguments.Count -eq 2 -and
    (Test-AmExecutableArgument -Argument $arguments[0] -ExecutablePath ([string]$Process.ExecutablePath)) -and
    (Test-AmExactPathArgument -Actual $arguments[1] -Expected (Join-Path $AppDirectory 'dist\index.mjs'))
}

function Test-AmProcessCreationMatches {
  param(
    [Parameter(Mandatory = $true)]$Process,
    [Parameter(Mandatory = $true)][string]$StartedAt
  )
  if ([string]::IsNullOrWhiteSpace($StartedAt) -or -not $Process.CreationDate) { return $false }
  try {
    $expected = [DateTimeOffset]::Parse($StartedAt)
    if ($Process.CreationDate -is [DateTime]) {
      $actualDate = [DateTime]$Process.CreationDate
    } else {
      $parsedDate = [DateTime]::MinValue
      if ([DateTime]::TryParse([string]$Process.CreationDate, [ref]$parsedDate)) {
        $actualDate = $parsedDate
      } else {
        $actualDate = [System.Management.ManagementDateTimeConverter]::ToDateTime([string]$Process.CreationDate)
      }
    }
    $actual = [DateTimeOffset]$actualDate
    return [Math]::Abs(($actual - $expected).TotalSeconds) -le 1
  } catch {
    return $false
  }
}

function Get-AmInstanceProcessState {
  param(
    [Parameter(Mandatory = $true)][string]$InstanceHome,
    [Parameter(Mandatory = $true)][string]$InstanceId,
    [Parameter(Mandatory = $true)][string]$AppDirectory,
    [array]$AllProcesses = @()
  )
  if ($AllProcesses.Count -eq 0) { $AllProcesses = Get-AmProcesses }
  $AllProcesses = @($AllProcesses | Where-Object { $null -ne $_ })

  $supervisorPidPath = Join-Path $InstanceHome 'supervisor.pid'
  $workerLockPath = Join-Path $InstanceHome 'worker.lock.json'
  $workerPidPath = Join-Path $InstanceHome 'worker.pid'
  $shutdownPath = Join-Path $InstanceHome 'supervisor.shutdown.json'
  $supervisorRecord = Read-AmJsonFile -Path $supervisorPidPath
  $workerRecord = Read-AmJsonFile -Path $workerLockPath
  $recordSupervisorPid = Get-AmJsonInteger -Value $supervisorRecord -Names @('pid', 'supervisorPid')
  $recordSupervisorStartedAt = Get-AmJsonString -Value $supervisorRecord -Names @('startedAt', 'supervisorStartedAt')
  $recordInstanceId = Get-AmJsonString -Value $supervisorRecord -Names @('instanceId')
  $recordWorkerPid = Get-AmJsonInteger -Value $workerRecord -Names @('workerPid', 'pid')
  $recordWorkerSupervisorPid = Get-AmJsonInteger -Value $workerRecord -Names @('supervisorPid')
  $recordWorkerInstanceId = Get-AmJsonString -Value $workerRecord -Names @('instanceId')
  $recordWorkerStartedAt = Get-AmJsonString -Value $workerRecord -Names @('workerStartedAt')
  $recordWorkerSupervisorStartedAt = Get-AmJsonString -Value $workerRecord -Names @('supervisorStartedAt')
  $recordSupervisorProcess = if ($recordSupervisorPid -gt 0) { Get-AmProcessById -ProcessId $recordSupervisorPid -AllProcesses $AllProcesses } else { $null }
  $recordWorkerProcess = if ($recordWorkerPid -gt 0) { Get-AmProcessById -ProcessId $recordWorkerPid -AllProcesses $AllProcesses } else { $null }
  $legacyWorkerPid = Read-AmPidFile -Path $workerPidPath

  $supervisors = @($AllProcesses | Where-Object { Test-AmSupervisorProcess -Process $_ -InstanceId $InstanceId -AppDirectory $AppDirectory })
  $commandHosts = @($AllProcesses | Where-Object { Test-AmSupervisorCommandHostProcess -Process $_ -InstanceId $InstanceId -AppDirectory $AppDirectory })
  $workers = New-Object 'System.Collections.Generic.List[object]'
  foreach ($supervisor in $supervisors) {
    foreach ($child in @($AllProcesses | Where-Object { $_.ParentProcessId -and [int]$_.ParentProcessId -eq [int]$supervisor.ProcessId })) {
      if (Test-AmWorkerProcess -Process $child -AppDirectory $AppDirectory) { [void]$workers.Add($child) }
    }
  }
  if ($recordWorkerPid -gt 0) {
    $lockedWorker = Get-AmProcessById -ProcessId $recordWorkerPid -AllProcesses $AllProcesses
    if ($lockedWorker -and (Test-AmWorkerProcess -Process $lockedWorker -AppDirectory $AppDirectory)) { [void]$workers.Add($lockedWorker) }
  }
  if ($null -ne $legacyWorkerPid -and $legacyWorkerPid -gt 0) {
    $legacyWorker = Get-AmProcessById -ProcessId ([int]$legacyWorkerPid) -AllProcesses $AllProcesses
    if ($legacyWorker -and (Test-AmWorkerProcess -Process $legacyWorker -AppDirectory $AppDirectory)) { [void]$workers.Add($legacyWorker) }
  }
  $workers = @($workers | Sort-Object ProcessId -Unique)

  $supervisorRecordValid = $false
  if ($recordSupervisorPid -gt 0 -and $recordInstanceId -eq $InstanceId) {
    $supervisorRecordValid = [bool]($recordSupervisorProcess -and
      (Test-AmSupervisorProcess -Process $recordSupervisorProcess -InstanceId $InstanceId -AppDirectory $AppDirectory) -and
      (Test-AmProcessCreationMatches -Process $recordSupervisorProcess -StartedAt $recordSupervisorStartedAt))
  }

  $workerRecordIdentityValid = $false
  if ($recordWorkerPid -gt 0 -and $recordWorkerSupervisorPid -gt 0 -and $recordWorkerInstanceId -eq $InstanceId) {
    $workerRecordIdentityValid = [bool]($recordWorkerProcess -and
      (Test-AmWorkerProcess -Process $recordWorkerProcess -AppDirectory $AppDirectory) -and
      (Test-AmProcessCreationMatches -Process $recordWorkerProcess -StartedAt $recordWorkerStartedAt))
  }
  $workerRecordValid = [bool]($workerRecordIdentityValid -and
    [int]$recordWorkerProcess.ParentProcessId -eq $recordWorkerSupervisorPid -and
    $recordWorkerSupervisorStartedAt -eq $recordSupervisorStartedAt -and
    $supervisorRecordValid)

  return [PSCustomObject]@{
    SupervisorPidPath = $supervisorPidPath
    WorkerLockPath = $workerLockPath
    WorkerPidPath = $workerPidPath
    ShutdownPath = $shutdownPath
    SupervisorRecord = $supervisorRecord
    WorkerRecord = $workerRecord
    RecordSupervisorPid = $recordSupervisorPid
    RecordWorkerPid = $recordWorkerPid
    SupervisorRecordProcessAlive = [bool]$recordSupervisorProcess
    WorkerRecordProcessAlive = [bool]$recordWorkerProcess
    SupervisorRecordValid = $supervisorRecordValid
    WorkerRecordIdentityValid = $workerRecordIdentityValid
    WorkerRecordValid = $workerRecordValid
    Supervisors = @($supervisors)
    CommandHosts = @($commandHosts)
    Workers = @($workers)
  }
}

function Assert-AmInstanceStartReady {
  param(
    [Parameter(Mandatory = $true)][string]$InstanceHome,
    [Parameter(Mandatory = $true)][string]$InstanceId,
    [Parameter(Mandatory = $true)][string]$AppDirectory
  )
  $state = Get-AmInstanceProcessState -InstanceHome $InstanceHome -InstanceId $InstanceId -AppDirectory $AppDirectory
  if (Test-Path -LiteralPath $state.ShutdownPath -PathType Leaf) {
    throw "Refusing $InstanceId start: residual supervisor shutdown request exists."
  }
  if ($state.Supervisors.Count -gt 0 -or $state.CommandHosts.Count -gt 0) {
    throw "Refusing $InstanceId start: a matching supervisor process or command host is already alive."
  }
  if ($state.Workers.Count -gt 0) {
    throw "Refusing $InstanceId start: a matching live worker lock identifies an orphan worker."
  }
  if ($state.SupervisorRecordProcessAlive -or $state.WorkerRecordProcessAlive) {
    throw "Refusing $InstanceId start: a PID/lock record references a live process but its identity is not fully verified."
  }
  if ((Test-Path -LiteralPath $state.SupervisorPidPath -PathType Leaf) -and $null -eq $state.SupervisorRecord) {
    throw "Refusing $InstanceId start: supervisor PID file is malformed."
  }
  if ((Test-Path -LiteralPath $state.WorkerLockPath -PathType Leaf) -and $null -eq $state.WorkerRecord) {
    throw "Refusing $InstanceId start: worker lock file is malformed."
  }
}

function Invoke-AmSupervisorShutdownRequest {
  param(
    [Parameter(Mandatory = $true)][string]$InstanceHome,
    [Parameter(Mandatory = $true)][string]$InstanceId,
    [Parameter(Mandatory = $true)][string]$AppDirectory,
    [Parameter(Mandatory = $true)][string]$SupervisorEntry
  )
  $state = Get-AmInstanceProcessState -InstanceHome $InstanceHome -InstanceId $InstanceId -AppDirectory $AppDirectory
  if ($state.Supervisors.Count -eq 0 -and -not (Test-Path -LiteralPath $state.SupervisorPidPath -PathType Leaf)) {
    return 'NoSupervisor'
  }
  if (-not $state.SupervisorRecordValid -or $state.Supervisors.Count -ne 1) {
    Write-Host "supervisor.request=identity_not_verified instance=$InstanceId"
    return 'Rejected'
  }
  if (-not (Test-Path -LiteralPath $SupervisorEntry -PathType Leaf)) {
    Write-Host "supervisor.request=entry_missing instance=$InstanceId"
    return 'Rejected'
  }
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $node) { $node = Get-Command node -ErrorAction SilentlyContinue }
  if (-not $node) {
    Write-Host "supervisor.request=node_missing instance=$InstanceId"
    return 'Rejected'
  }
  $diagnostics = @(& $node.Source $SupervisorEntry --request-shutdown --instance-id $InstanceId --home $InstanceHome)
  $exitCode = $LASTEXITCODE
  foreach ($diagnostic in $diagnostics) { Write-Host $diagnostic }
  Write-Host "supervisor.request.exitCode=$exitCode"
  if ($exitCode -eq 0) { return 'Accepted' }
  return 'Rejected'
}

function Wait-AmInstanceProcessesStopped {
  param(
    [Parameter(Mandatory = $true)][string]$InstanceHome,
    [Parameter(Mandatory = $true)][string]$InstanceId,
    [Parameter(Mandatory = $true)][string]$AppDirectory,
    [int]$TimeoutSeconds = 15
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $state = Get-AmInstanceProcessState -InstanceHome $InstanceHome -InstanceId $InstanceId -AppDirectory $AppDirectory
    if ($state.Supervisors.Count -eq 0 -and $state.CommandHosts.Count -eq 0 -and $state.Workers.Count -eq 0 -and
        -not $state.SupervisorRecordProcessAlive -and -not $state.WorkerRecordProcessAlive) {
      return $true
    }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Stop-AmVerifiedInstanceResiduals {
  param(
    [Parameter(Mandatory = $true)][string]$InstanceHome,
    [Parameter(Mandatory = $true)][string]$InstanceId,
    [Parameter(Mandatory = $true)][string]$AppDirectory
  )
  $state = Get-AmInstanceProcessState -InstanceHome $InstanceHome -InstanceId $InstanceId -AppDirectory $AppDirectory
  $targets = Get-AmVerifiedResidualStopTargets -State $state
  foreach ($supervisor in $targets.Supervisors) {
    Write-Output "stopping.supervisorPid=$($supervisor.ProcessId)"
    Stop-Process -Id ([int]$supervisor.ProcessId) -Force -ErrorAction SilentlyContinue
  }
  foreach ($worker in $targets.Workers) {
    Write-Output "stopping.workerPid=$($worker.ProcessId)"
    Stop-Process -Id ([int]$worker.ProcessId) -Force -ErrorAction SilentlyContinue
  }
  foreach ($hostProcess in $targets.CommandHosts) {
    Write-Output "stopping.commandHostPid=$($hostProcess.ProcessId)"
    Stop-Process -Id ([int]$hostProcess.ProcessId) -Force -ErrorAction SilentlyContinue
  }
}

function Get-AmVerifiedResidualStopTargets {
  param([Parameter(Mandatory = $true)]$State)
  $supervisors = @()
  $workers = @()
  $commandHosts = @()
  if ($State.SupervisorRecordValid -and $State.Supervisors.Count -eq 1 -and
      [int]$State.Supervisors[0].ProcessId -eq [int]$State.RecordSupervisorPid) {
    $supervisors = @($State.Supervisors[0])
  }
  if ($State.WorkerRecordIdentityValid -and $State.Workers.Count -eq 1 -and
      [int]$State.Workers[0].ProcessId -eq [int]$State.RecordWorkerPid) {
    $workers = @($State.Workers[0])
  }
  if ($State.CommandHosts.Count -eq 1 -and ($supervisors.Count -eq 1 -or $workers.Count -eq 1)) {
    $commandHosts = @($State.CommandHosts[0])
  }
  return [PSCustomObject]@{
    Supervisors = $supervisors
    Workers = $workers
    CommandHosts = $commandHosts
  }
}

function Write-AmInstanceProcessReport {
  param(
    [Parameter(Mandatory = $true)]$State,
    [string]$Prefix = 'process'
  )
  Write-Output "$Prefix.supervisorCount=$($State.Supervisors.Count)"
  Write-Output "$Prefix.commandHostCount=$($State.CommandHosts.Count)"
  Write-Output "$Prefix.workerCount=$($State.Workers.Count)"
  Write-Output "$Prefix.supervisorRecordValid=$($State.SupervisorRecordValid)"
  Write-Output "$Prefix.workerRecordValid=$($State.WorkerRecordValid)"
  Write-Output "$Prefix.workerRecordIdentityValid=$($State.WorkerRecordIdentityValid)"
  Write-Output "$Prefix.supervisorRecordProcessAlive=$($State.SupervisorRecordProcessAlive)"
  Write-Output "$Prefix.workerRecordProcessAlive=$($State.WorkerRecordProcessAlive)"
}

function Invoke-AmWorkerSupervisionValidation {
  param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [Parameter(Mandatory = $true)][string]$AppDirectory,
    [Parameter(Mandatory = $true)][string]$InstanceId,
    [Parameter(Mandatory = $true)][string]$ExpectedStatePath,
    [Parameter(Mandatory = $true)][string]$ExpectedStreamPath
  )
  $validator = Join-Path $PSScriptRoot 'validate-agentmemory-worker-supervision.mjs'
  Assert-AmRequiredFile -Path $validator -Name 'worker supervision validator'
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $node) { $node = Get-Command node -ErrorAction SilentlyContinue }
  if (-not $node) { throw 'Node.js is required for worker supervision validation.' }
  & $node.Source $validator `
    --config $ConfigPath `
    --app-dir $AppDirectory `
    --expected-instance-id $InstanceId `
    --expected-state-path $ExpectedStatePath `
    --expected-stream-path $ExpectedStreamPath
  if ($LASTEXITCODE -ne 0) {
    throw "Worker supervision validation failed for instance '$InstanceId'."
  }
}

function Remove-AmStoppedInstanceShutdownRequest {
  param(
    [Parameter(Mandatory = $true)][string]$InstanceHome,
    [Parameter(Mandatory = $true)][string]$InstanceId,
    [Parameter(Mandatory = $true)][string]$AppDirectory
  )
  $state = Get-AmInstanceProcessState -InstanceHome $InstanceHome -InstanceId $InstanceId -AppDirectory $AppDirectory
  if ($state.Supervisors.Count -gt 0 -or $state.CommandHosts.Count -gt 0 -or $state.Workers.Count -gt 0 -or
      $state.SupervisorRecordProcessAlive -or $state.WorkerRecordProcessAlive) {
    return $false
  }
  if (Test-Path -LiteralPath $state.ShutdownPath -PathType Leaf) {
    Remove-Item -LiteralPath $state.ShutdownPath -Force
  }
  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmssfff'
  foreach ($stalePath in @($state.SupervisorPidPath, $state.WorkerLockPath, $state.WorkerPidPath)) {
    if (Test-Path -LiteralPath $stalePath -PathType Leaf) {
      Move-Item -LiteralPath $stalePath -Destination "$stalePath.stale-$timestamp" -Force
    }
  }
  return $true
}
