# Walks up the process tree and, for each ancestor, tries AttachConsole +
# CreateFile("CONOUT$") + GetConsoleScreenBufferInfo to find the real
# terminal's width. Necessary on Windows because PowerShell launched from
# a non-TTY parent (typical for hook subprocesses) gets a phantom default
# console; the user-facing terminal lives further up the chain.
#
# Logs each ancestor's result to ~/.claude/.statusline-width-debug.log
# Prints the best-guess width to stdout (or nothing if none found).

$ErrorActionPreference = 'SilentlyContinue'
$log = Join-Path $env:USERPROFILE '.claude\.statusline-width-debug.log'
# Buffer the log in memory and flush once at the end. Out-File -Append reopens
# the file per call (~20-40ms on Windows PowerShell); this script logs ~25
# lines, so appending line-by-line cost more than the actual probing did.
$logLines = [System.Collections.Generic.List[string]]::new()
function Log($msg) { [void]$logLines.Add([string]$msg) }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
Log "===== $(Get-Date -Format o) ====="

Add-Type -Name K -Namespace Win32 -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint dwProcessId);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr CreateFile(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr hObject);
[StructLayout(LayoutKind.Sequential)] public struct COORD { public short X; public short Y; }
[StructLayout(LayoutKind.Sequential)] public struct SMALL_RECT { public short Left; public short Top; public short Right; public short Bottom; }
[StructLayout(LayoutKind.Sequential)] public struct CONSOLE_SCREEN_BUFFER_INFO {
  public COORD dwSize;
  public COORD dwCursorPosition;
  public ushort wAttributes;
  public SMALL_RECT srWindow;
  public COORD dwMaximumWindowSize;
}
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetConsoleScreenBufferInfo(IntPtr hConsoleOutput, out CONSOLE_SCREEN_BUFFER_INFO lpConsoleScreenBufferInfo);
'@

Log "baseline Host.WindowSize.Width = $($Host.UI.RawUI.WindowSize.Width)"

# One CIM query for the whole process table, indexed by PID. Each filtered
# Get-CimInstance costs ~150ms on Windows, and the walk below needs a parent
# and a name for every ancestor — ~20 queries, ~3s, which is most of this
# script's runtime. A single unfiltered snapshot of all ~460 processes costs
# ~180ms and answers every lookup from memory.
$procTable = @{}
Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name -ErrorAction SilentlyContinue |
  ForEach-Object { $procTable[[int]$_.ProcessId] = $_ }

function Get-ParentPid($processId) {
  $p = $procTable[[int]$processId]
  if ($p) { $p.ParentProcessId }
}
function Get-ProcName($processId) {
  $p = $procTable[[int]$processId]
  if ($p) { $p.Name }
}

# Constants for CreateFile
$GENERIC_READ     = [uint32]'0x80000000'
$GENERIC_WRITE    = [uint32]'0x40000000'
$FILE_SHARE_READ  = [uint32]1
$FILE_SHARE_WRITE = [uint32]2
$OPEN_EXISTING    = [uint32]3
$INVALID_HANDLE   = [IntPtr]::new(-1)

function Try-GetWidth {
  # Open the *currently attached* console's screen buffer.
  # GetStdHandle(STD_OUTPUT) won't work here — that returns PowerShell's
  # own pipe handle, not the attached console.
  $h = [Win32.K]::CreateFile("CONOUT$", ($GENERIC_READ -bor $GENERIC_WRITE), ($FILE_SHARE_READ -bor $FILE_SHARE_WRITE), [IntPtr]::Zero, $OPEN_EXISTING, 0, [IntPtr]::Zero)
  if ($h -eq $INVALID_HANDLE) {
    return @{ ok=$false; err="CreateFile CONOUT$ failed (LastError=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))" }
  }
  try {
    $info = New-Object Win32.K+CONSOLE_SCREEN_BUFFER_INFO
    if ([Win32.K]::GetConsoleScreenBufferInfo($h, [ref]$info)) {
      $w = $info.srWindow.Right - $info.srWindow.Left + 1
      $bw = $info.dwSize.X
      return @{ ok=$true; window=$w; buffer=$bw }
    } else {
      return @{ ok=$false; err="GetConsoleScreenBufferInfo failed (LastError=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))" }
    }
  } finally {
    [void][Win32.K]::CloseHandle($h)
  }
}

$bestWidth = $null
$cur = $PID
Log "current PID = $cur ($(Get-ProcName $cur))"

for ($i = 0; $i -lt 12; $i++) {
  $parent = Get-ParentPid $cur
  if (-not $parent -or $parent -eq 0) { Log "  no parent - stop"; break }
  $name = Get-ProcName $parent
  Log "  ancestor[$i]: PID=$parent name=$name"

  [void][Win32.K]::FreeConsole()
  $ok = [Win32.K]::AttachConsole([uint32]$parent)
  if ($ok) {
    $r = Try-GetWidth
    if ($r.ok) {
      Log "    attached OK: window width=$($r.window)  buffer width=$($r.buffer)"
      # Take the LAST (highest) successful attach — child bash processes get
      # phantom default consoles, the real terminal is owned further up.
      if ($r.window -gt 0) { $bestWidth = $r.window }
    } else {
      Log "    attached but $($r.err)"
    }
    [void][Win32.K]::FreeConsole()
  } else {
    Log "    AttachConsole failed (LastError=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
  }

  $cur = $parent
}

if ($bestWidth) {
  Log "best width = $bestWidth"
} else {
  Log "no width found"
}
Log "elapsed = $($sw.ElapsedMilliseconds)ms"
$logLines | Out-File -FilePath $log -Encoding utf8

if ($bestWidth) { Write-Output $bestWidth }
