/**
 * The Windows side of the foreground ladder: one long-lived PowerShell
 * process that watches real keyboard and mouse input through low-level hooks
 * (events the machine injected carry a flag and are not counted), reads the
 * window in front, the cursor and the input desktop, and puts the window and
 * cursor back after a burst.
 *
 * It is handed to PowerShell as an encoded command, never as a file: a file
 * on the Linux side is reached through a network path on WSL, and compiling
 * from there took 80 s the first time. The line protocol is one JSON object
 * per line in each direction.
 *
 * Should the program that started it die, its input closes; the helper then
 * puts back what a burst in progress had moved and deletes the lease file, so
 * a crash cannot leave the user's window or cursor displaced or the screen
 * leased.
 */
export const WINDOWS_HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @"
using System; using System.Text; using System.Threading; using System.Runtime.InteropServices;
public static class NzG {
 [StructLayout(LayoutKind.Sequential)] public struct LII { public uint cb; public uint t; }
 [StructLayout(LayoutKind.Sequential)] public struct PT { public int x; public int y; }
 [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr h; public uint m; public IntPtr w; public IntPtr l; public uint t; public PT p; }
 delegate IntPtr LL(int c, IntPtr w, IntPtr l);
 [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LII p);
 [DllImport("user32.dll")] static extern bool GetCursorPos(out PT p);
 [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool f);
 [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
 [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, LL f, IntPtr m, uint t);
 [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int c, IntPtr w, IntPtr l);
 [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint a, uint b);
 [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint f, bool i, uint a);
 [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr d);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr d, int i, StringBuilder s, int n, out int need);
 [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string n);
 [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
 [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint a, bool i, uint pid);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr p, uint f, StringBuilder s, ref int n);
 [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr p, uint a, out IntPtr t);
 [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr t, int c, out int v, int n, out int r);
 static LL kp, mp; static IntPtr kh, mh;
 public static long Inputs, Escapes, LastReal; public static bool Hooks; public static string HookError = "";
 static ManualResetEvent ready = new ManualResetEvent(false);
 static IntPtr K(int c, IntPtr w, IntPtr l) {
  if (c >= 0) {
   int m = (int)w; int flags = Marshal.ReadInt32(l, 8);
   if ((flags & 0x10) == 0 && (m == 0x100 || m == 0x104)) {
    Interlocked.Increment(ref Inputs); Interlocked.Exchange(ref LastReal, Environment.TickCount);
    if (Marshal.ReadInt32(l, 0) == 0x1B) Interlocked.Increment(ref Escapes);
   }
  }
  return CallNextHookEx(IntPtr.Zero, c, w, l);
 }
 static IntPtr M(int c, IntPtr w, IntPtr l) {
  if (c >= 0) {
   int flags = Marshal.ReadInt32(l, 12);
   if ((flags & 1) == 0) { Interlocked.Increment(ref Inputs); Interlocked.Exchange(ref LastReal, Environment.TickCount); }
  }
  return CallNextHookEx(IntPtr.Zero, c, w, l);
 }
 public static bool StartHooks() {
  var t = new Thread(() => {
   kp = K; mp = M; var mod = GetModuleHandle(null);
   kh = SetWindowsHookEx(13, kp, mod, 0); mh = SetWindowsHookEx(14, mp, mod, 0);
   Hooks = kh != IntPtr.Zero && mh != IntPtr.Zero;
   if (!Hooks) HookError = "SetWindowsHookEx failed " + Marshal.GetLastWin32Error();
   ready.Set();
   if (!Hooks) return;
   MSG msg; while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
  });
  t.IsBackground = true; t.SetApartmentState(ApartmentState.STA); t.Start();
  ready.WaitOne(5000); return Hooks;
 }
 public static long GliTick() { LII l = new LII(); l.cb = 8; GetLastInputInfo(ref l); return l.t; }
 public static long Tick() { return (long)(uint)Environment.TickCount; }
 public static long Since(long t) { return (long)(uint)(Environment.TickCount - (int)t); }
 public static int CursorX() { PT p; GetCursorPos(out p); return p.x; }
 public static int CursorY() { PT p; GetCursorPos(out p); return p.y; }
 public static bool Cursor(int x, int y) { return SetCursorPos(x, y); }
 public static long Fg() { return (long)GetForegroundWindow(); }
 public static uint PidOf(long h) { uint p; GetWindowThreadProcessId((IntPtr)h, out p); return p; }
 public static string Exe(uint pid) {
  IntPtr h = OpenProcess(0x1000, false, pid); if (h == IntPtr.Zero) return "";
  try { var sb = new StringBuilder(520); int n = 520; if (!QueryFullProcessImageName(h, 0, sb, ref n)) return ""; var s = sb.ToString(); int i = s.LastIndexOf('\\'); return i >= 0 ? s.Substring(i + 1) : s; } finally { CloseHandle(h); }
 }
 public static bool Elevated(uint pid) {
  IntPtr h = OpenProcess(0x1000, false, pid);
  if (h == IntPtr.Zero) return true;
  try { IntPtr t; if (!OpenProcessToken(h, 8, out t)) return false; try { int v, r; return GetTokenInformation(t, 20, out v, 4, out r) && v != 0; } finally { CloseHandle(t); } } finally { CloseHandle(h); }
 }
 public static string Desktop() {
  IntPtr d = OpenInputDesktop(0, false, 1); if (d == IntPtr.Zero) return "(unreadable)";
  try { var sb = new StringBuilder(256); int need; if (!GetUserObjectInformation(d, 2, sb, 512, out need)) return "(unreadable)"; return sb.ToString(); } finally { CloseDesktop(d); }
 }
 public static bool Raise(long hv) {
  IntPtr h = (IntPtr)hv; if (!IsWindow(h)) return false;
  IntPtr cur = GetForegroundWindow(); if (cur == h) return true;
  uint p; uint ct = GetWindowThreadProcessId(cur, out p); uint mt = GetCurrentThreadId();
  bool at = ct != 0 && ct != mt && AttachThreadInput(mt, ct, true);
  if (IsIconic(h)) ShowWindow(h, 9);
  SetForegroundWindow(h);
  if (at) AttachThreadInput(mt, ct, false);
  return GetForegroundWindow() == h;
 }
}
"@
$hooks = [NzG]::StartHooks()
$selfElevated = [NzG]::Elevated([uint32]$PID)
$ownStart = 0; $ownEnd = 0
$burst = $null
function Hx($h) { '0x{0:X}' -f [int64]$h }
function State($pidArg) {
  $fgH = [NzG]::Fg(); $fgPid = [NzG]::PidOf($fgH)
  $gli = [NzG]::GliTick()
  $real = [NzG]::LastReal
  $realIdle = if ($real -eq 0) { [int64]::MaxValue } else { [NzG]::Since($real) }
  $own = ($ownStart -ne 0 -and [NzG]::Since($gli) -le [NzG]::Since($ownStart) -and ($ownEnd -eq 0 -or [NzG]::Since($gli) -ge ([NzG]::Since($ownEnd) - 300)))
  $gliIdle = if ($own) { [int64]::MaxValue } else { [NzG]::Since($gli) }
  $idle = [Math]::Min($realIdle, $gliIdle)
  if ($idle -eq [int64]::MaxValue) { $idle = 86400000 }
  $r = @{
    userIdleMs = $idle; userInputs = [NzG]::Inputs; escapes = [NzG]::Escapes; desktop = [NzG]::Desktop(); selfElevated = $selfElevated
    cursor = @{ x = [NzG]::CursorX(); y = [NzG]::CursorY() }
    foreground = @{ hwnd = (Hx $fgH); pid = $fgPid; exe = [NzG]::Exe($fgPid); elevated = [NzG]::Elevated($fgPid) }
  }
  if ($pidArg) { $r.target = @{ exe = [NzG]::Exe([uint32]$pidArg); elevated = [NzG]::Elevated([uint32]$pidArg) } }
  $r
}
function EndBurst($restore, $keepCursor) {
  $res = @{ inputsDuring = 0; escapesDuring = 0; restoredForeground = $false; restoredCursor = $false }
  if ($null -eq $script:burst) { return $res }
  $b = $script:burst; $script:burst = $null
  $script:ownEnd = [NzG]::Tick()
  $res.inputsDuring = [NzG]::Inputs - $b.inputs; $res.escapesDuring = [NzG]::Escapes - $b.escapes
  if ($restore) {
    # The window is put back only when this burst raised one and it (or another
    # window of its program) is still in front: otherwise the user, or a
    # click of the burst, has already moved on and is left alone.
    if ($b.raised -ne 0 -and $b.fg -ne 0 -and [NzG]::Fg() -ne $b.fg) {
      $cur = [NzG]::Fg()
      if ($cur -eq $b.raised -or ([NzG]::PidOf($cur) -eq $b.raisedPid)) { $res.restoredForeground = [NzG]::Raise($b.fg) }
    }
  }
  if ($restore -and $res.inputsDuring -eq 0) {
    if (-not $keepCursor -and ([NzG]::CursorX() -ne $b.x -or [NzG]::CursorY() -ne $b.y)) { $res.restoredCursor = [NzG]::Cursor($b.x, $b.y) }
  }
  $res
}
function Release($path, $token) {
  if (-not $path) { return }
  try { if (Test-Path -LiteralPath $path) { $t = (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json).token; if ($t -eq $token) { Remove-Item -LiteralPath $path -Force } } } catch { }
}
function Reply($o) { [Console]::Out.WriteLine((ConvertTo-Json -InputObject $o -Compress -Depth 6)) }
Reply @{ ok = $true; hooks = $hooks; hookError = [NzG]::HookError; selfElevated = $selfElevated }
while (($line = [Console]::In.ReadLine()) -ne $null) {
  $cid = $null
  try {
    $c = $line | ConvertFrom-Json
    $cid = $c.id
    switch ($c.cmd) {
      'state' { $r = State $c.pid }
      'begin' {
        $script:burst = @{ inputs = [NzG]::Inputs; escapes = [NzG]::Escapes; fg = [NzG]::Fg(); raised = 0; raisedPid = 0; x = [NzG]::CursorX(); y = [NzG]::CursorY(); lease = $c.lease; token = $c.token }
        $pre = State $null
        if ($c.idleMs -and $pre.userIdleMs -lt [int64]$c.idleMs) {
          # A person is still using the machine: move nothing.
          $script:burst = $null
          $r = $pre; $r.refused = $true
        } else {
          $script:ownStart = [NzG]::Tick(); $script:ownEnd = 0
          $raised = $null
          if ($c.raise) {
            $target = [Convert]::ToInt64(([string]$c.raise).Substring(2), 16)
            $raised = [NzG]::Raise($target)
            if ($raised -and [NzG]::Fg() -ne $script:burst.fg) { $script:burst.raised = $target; $script:burst.raisedPid = [NzG]::PidOf($target) }
          }
          $r = State $null
          if ($null -ne $raised) { $r.raised = $raised }
        }
      }
      'end' { $r = EndBurst ([bool]$c.restore) ([bool]$c.keepCursor) }
      'release' { Release $c.lease $c.token; $r = @{ ok = $true } }
      'quit' { break }
      default { $r = @{ error = 'unknown command' } }
    }
    if ($c.cmd -eq 'quit') { break }
    Reply @{ ok = $true; id = $cid; r = $r }
  } catch {
    Reply @{ ok = $false; id = $cid; error = "$_" }
  }
}
if ($null -ne $burst) { $keep = $burst; EndBurst $true $false | Out-Null; Release $keep.lease $keep.token }
`
