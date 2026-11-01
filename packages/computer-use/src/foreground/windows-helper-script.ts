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
 [DllImport("user32.dll")] static extern void SwitchToThisWindow(IntPtr h, bool alt);
 [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
 [StructLayout(LayoutKind.Sequential)] public struct RC { public int l; public int t; public int r; public int b; }
 [StructLayout(LayoutKind.Sequential)] public struct GTI { public int cb; public int fl; public IntPtr act; public IntPtr foc; public IntPtr cap; public IntPtr mo; public IntPtr ms; public IntPtr car; public RC rc; }
 delegate bool EP(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EP f, IntPtr l);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] static extern bool IsChild(IntPtr p, IntPtr c);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RC r);
 [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
 [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint t, ref GTI i);
 [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
 [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, string l, uint f, uint t, out IntPtr r);
 [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, StringBuilder l, uint f, uint t, out IntPtr r);
 [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint t, out IntPtr r);
 [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
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
 [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr t, int c, IntPtr v, int n, out int r);
 [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
 [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint i);
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
  try { SetProcessDPIAware(); } catch { }
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
 // The mandatory integrity level of a process as its RID: 0x1000 low, 0x2000 medium,
 // 0x3000 high, 0x4000 system. -1 when it cannot be read (a program with higher rights refuses).
 public static int Integrity(uint pid) {
  IntPtr h = OpenProcess(0x1000, false, pid);
  if (h == IntPtr.Zero) return -1;
  try {
   IntPtr t; if (!OpenProcessToken(h, 8, out t)) return -1;
   try {
    int need; GetTokenInformation(t, 25, IntPtr.Zero, 0, out need);
    if (need <= 0) return -1;
    IntPtr buf = Marshal.AllocHGlobal(need);
    try {
     if (!GetTokenInformation(t, 25, buf, need, out need)) return -1;
     IntPtr sid = Marshal.ReadIntPtr(buf);
     int n = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
     if (n < 1) return -1;
     return Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(n - 1)));
    } finally { Marshal.FreeHGlobal(buf); }
   } finally { CloseHandle(t); }
  } finally { CloseHandle(h); }
 }
 static int selfRid = -2;
 public static int SelfIntegrity() { if (selfRid == -2) selfRid = Integrity(GetCurrentProcessId()); return selfRid; }
 // Whether Windows keeps this program's input from that process: it runs above us, or cannot be read.
 public static bool Elevated(uint pid) {
  int r = Integrity(pid); if (r < 0) return true;
  return r > SelfIntegrity();
 }
 // Whether a process is positively read to run above this program's rights; unreadable is not a yes.
 public static bool Above(uint pid) {
  if (pid == 0) return false;
  int r = Integrity(pid); return r >= 0 && r > SelfIntegrity();
 }
 public static string Desktop() {
  IntPtr d = OpenInputDesktop(0, false, 1); if (d == IntPtr.Zero) return "(unreadable)";
  try { var sb = new StringBuilder(256); int need; if (!GetUserObjectInformation(d, 2, sb, 512, out need)) return "(unreadable)"; return sb.ToString(); } finally { CloseDesktop(d); }
 }
 public class EditRes { public bool Found; public string Reason = ""; public long Hwnd; public string Cls = ""; public bool Done; public long Len; public string Text = ""; public string Seen = ""; }
 static bool EditClass(string c) { return c == "Edit" || c.StartsWith("RichEdit", StringComparison.OrdinalIgnoreCase) || c.StartsWith("RICHEDIT", StringComparison.OrdinalIgnoreCase); }
 static string ClassOf(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
 // How many times a text occurs in another, without overlap: typing one letter after another is judged on the text so far.
 static int Occ(string text, string want) {
  if (want.Length == 0) return 0;
  int n = 0, at = text.IndexOf(want, StringComparison.Ordinal);
  while (at >= 0) { n++; at = text.IndexOf(want, at + want.Length, StringComparison.Ordinal); }
  return n;
 }
 static string Norm(string s) { return s.Replace("\r\n", "\n").Replace("\r", "\n"); }
 // The text of an edit control through WM_GETTEXT; null when it cannot be read.
 static string TextOf(IntPtr h, out string why) {
  why = ""; IntPtr r;
  if (SendMessageTimeout(h, 0xE, IntPtr.Zero, IntPtr.Zero, 2, 2000, out r) == IntPtr.Zero) { why = Marshal.GetLastWin32Error() == 5 ? "uipi" : "hung"; return null; }
  long n = (long)r; if (n > 2000000) { why = "unreadable"; return null; }
  var sb = new StringBuilder((int)n + 2);
  if (SendMessageTimeout(h, 0xD, (IntPtr)(n + 1), sb, 2, 2000, out r) == IntPtr.Zero && n > 0) { why = Marshal.GetLastWin32Error() == 5 ? "uipi" : "hung"; return null; }
  return sb.ToString();
 }
 public static EditRes EditOp(long top, string op, string text, int cx, int cy, bool hasC, string pick) {
  var res = new EditRes(); IntPtr t = (IntPtr)top;
  if (!IsWindow(t)) { res.Reason = "gone"; return res; }
  uint pid; uint tid = GetWindowThreadProcessId(t, out pid);
  if (Elevated(pid)) { res.Reason = "uipi"; return res; }
  var found = new System.Collections.Generic.List<IntPtr>();
  EnumChildWindows(t, (h, l) => { if (IsWindowVisible(h) && EditClass(ClassOf(h))) found.Add(h); return true; }, IntPtr.Zero);
  IntPtr pickH = IntPtr.Zero;
  if (pick == "focus") {
   var g = new GTI(); g.cb = Marshal.SizeOf(typeof(GTI));
   // Only a focus inside the chosen window counts: a dialog of the same thread is not it.
   bool have = GetGUIThreadInfo(tid, ref g);
   if (have && g.foc != IntPtr.Zero) {
    if ((g.foc == t || IsChild(t, g.foc)) && EditClass(ClassOf(g.foc))) pickH = g.foc;
   } else if (have && (g.act == IntPtr.Zero || g.act == t) && found.Count == 1) {
    // A thread that is not the active one has no focus window at all. With no other active window of
    // the thread (a dialog) and a single edit control in the chosen window, that control is the target.
    // A focus on any other control, or on another window, never reaches here.
    pickH = found[0];
   }
  } else if (hasC) {
   foreach (var h in found) { RC rc; if (GetWindowRect(h, out rc) && cx >= rc.l && cx < rc.r && cy >= rc.t && cy < rc.b) { pickH = h; break; } }
  }
  if (pickH == IntPtr.Zero) {
   // The lone-edit shortcut is for a chosen place only; a focus that is not an edit is not one.
   if (pick == "focus") { res.Reason = "no_edit"; return res; }
   if (found.Count == 1) pickH = found[0];
   else { res.Reason = found.Count == 0 ? "no_edit" : "ambiguous"; return res; }
  }
  res.Found = true; res.Hwnd = (long)pickH; res.Cls = ClassOf(pickH);
  int style = GetWindowLong(pickH, -16);
  if (op != "get" && (style & 0x800) != 0) { res.Reason = "read_only"; return res; }
  string why; string before = TextOf(pickH, out why);
  if (before == null) { res.Reason = why; return res; }
  if (op == "get") { res.Len = before.Length; res.Text = before.Length > 65536 ? before.Substring(0, 65536) : before; res.Done = true; return res; }
  string send = (style & 0x4) != 0 ? Norm(text).Replace("\n", "\r\n") : text;
  IntPtr rr;
  bool sent = op == "set"
   ? SendMessageTimeout(pickH, 0xC, IntPtr.Zero, send, 2, 3000, out rr) != IntPtr.Zero
   : SendMessageTimeout(pickH, 0xC2, (IntPtr)1, send, 2, 3000, out rr) != IntPtr.Zero;
  int err = sent ? 0 : Marshal.GetLastWin32Error();
  if (!sent) { res.Reason = err == 5 ? "uipi" : (err == 1460 ? "hung" : "refused"); return res; }
  string after = TextOf(pickH, out why);
  if (after == null) { res.Reason = "unreadable"; return res; }
  res.Len = after.Length;
  string a = Norm(after), b = Norm(before), w = Norm(text);
  res.Done = op == "set" ? a == w : (a != b && Occ(a, w) > Occ(b, w));
  int at = op == "type" ? a.IndexOf(w) : 0; if (at < 0) at = 0;
  int from = Math.Max(0, at - 40); res.Seen = a.Substring(from, Math.Min(a.Length - from, w.Length + 80));
  return res;
 }
 public static string How = "";
 public static bool Alive(long h) { return IsWindow((IntPtr)h); }
 public static bool Raise(long hv) {
  IntPtr h = (IntPtr)hv; if (!IsWindow(h)) { How = "gone"; return false; }
  IntPtr cur = GetForegroundWindow(); if (cur == h) { How = "already"; return true; }
  if (IsIconic(h)) ShowWindow(h, 9);
  SetForegroundWindow(h);
  if (GetForegroundWindow() == h) { How = "plain"; return true; }
  // Windows lets a program take the front only if it has just been given input. An
  // unassigned key tapped by this program (flagged as injected, so it is not counted
  // as a person's) gives it that right and does nothing in any window.
  keybd_event(0x87, 0, 0, UIntPtr.Zero); keybd_event(0x87, 0, 2, UIntPtr.Zero);
  SetForegroundWindow(h);
  if (GetForegroundWindow() == h) { How = "unlock"; return true; }
  uint p; uint ct = GetWindowThreadProcessId(cur, out p); uint mt = GetCurrentThreadId();
  bool at = ct != 0 && ct != mt && AttachThreadInput(mt, ct, true);
  SetForegroundWindow(h);
  if (at) AttachThreadInput(mt, ct, false);
  if (GetForegroundWindow() == h) { How = "attach"; return true; }
  SwitchToThisWindow(h, true);
  Thread.Sleep(30);
  if (GetForegroundWindow() == h) { How = "switch"; return true; }
  How = "refused"; return false;
 }
}
"@
$hooks = [NzG]::StartHooks()
$selfIntegrity = [NzG]::SelfIntegrity()
$selfElevated = ($selfIntegrity -ge 12288)
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
    userIdleMs = $idle; userInputs = [NzG]::Inputs; escapes = [NzG]::Escapes; desktop = [NzG]::Desktop(); selfElevated = $selfElevated; selfIntegrity = $selfIntegrity; inputTick = $gli
    cursor = @{ x = [NzG]::CursorX(); y = [NzG]::CursorY() }
    foreground = $null
  }
  if ($fgH -ne 0) { $r.foreground = @{ hwnd = (Hx $fgH); pid = $fgPid; exe = [NzG]::Exe($fgPid); elevated = [NzG]::Elevated($fgPid); integrity = [NzG]::Integrity($fgPid) } }
  if ($pidArg) { $r.target = @{ exe = [NzG]::Exe([uint32]$pidArg); elevated = [NzG]::Elevated([uint32]$pidArg); integrity = [NzG]::Integrity([uint32]$pidArg) } }
  $r
}
function EndBurst($restore, $keepCursor) {
  $res = @{ inputsDuring = 0; escapesDuring = 0; restoredForeground = $false; restoredCursor = $false }
  if ($null -eq $script:burst) { return $res }
  $b = $script:burst; $script:burst = $null
  $script:ownEnd = [NzG]::Tick()
  $res.inputsDuring = [NzG]::Inputs - $b.inputs; $res.escapesDuring = [NzG]::Escapes - $b.escapes
  # Input that Windows dropped (a window above this program's rights) leaves the tick where it was.
  $res.inputMoved = ([NzG]::GliTick() -ne $b.tick)
  $fgNow = [NzG]::Fg(); $res.frontElevated = [NzG]::Above([NzG]::PidOf($fgNow))
  if ($restore) {
    # The window is put back only when this burst moved the front: the window it
    # raised, or, where the raise was refused and the driver took the front itself,
    # the target (or another window of its program) now in front. Anything else in
    # front means the user, or a click of the burst, has already moved on: leave it.
    $cur = [NzG]::Fg()
    $mine = if ($b.raised -ne 0) { $b.raised } else { $b.target }
    $minePid = if ($b.raised -ne 0) { $b.raisedPid } else { $b.targetPid }
    if ($b.fg -eq 0 -or $mine -eq 0) { $res.restoreNote = 'the burst had no window to put back' }
    elseif ($cur -eq $b.fg) { $res.restoreNote = 'the window that was in front is in front again' }
    elseif ($cur -ne $mine -and ([NzG]::PidOf($cur) -ne $minePid -or $minePid -eq 0)) { $res.restoreNote = 'another window was in front by then, so it was left alone' }
    elseif (-not [NzG]::Alive($b.fg)) { $res.restoreNote = 'the window that was in front is gone' }
    else {
      $res.restoredForeground = [NzG]::Raise($b.fg); $res.restoreHow = [NzG]::How
      if (-not $res.restoredForeground) { $res.restoreNote = 'Windows would not give the front back to the previous window' }
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
        $script:burst = @{ inputs = [NzG]::Inputs; escapes = [NzG]::Escapes; fg = [NzG]::Fg(); raised = 0; raisedPid = 0; target = 0; targetPid = 0; tick = 0; x = [NzG]::CursorX(); y = [NzG]::CursorY(); lease = $c.lease; token = $c.token }
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
            $script:burst.target = $target; $script:burst.targetPid = [NzG]::PidOf($target)
            $raised = [NzG]::Raise($target)
            if ($raised -and [NzG]::Fg() -ne $script:burst.fg) { $script:burst.raised = $target; $script:burst.raisedPid = [NzG]::PidOf($target) }
          }
          # Taken after the raise: the unlock tap above is this program's own input.
          $script:burst.tick = [NzG]::GliTick()
          $r = State $null
          if ($null -ne $raised) { $r.raised = $raised; $r.raiseHow = [NzG]::How }
        }
      }
      'edit' {
        $t = [Convert]::ToInt64(([string]$c.hwnd).Substring(2), 16)
        $e = [NzG]::EditOp($t, [string]$c.op, [string]$c.text, [int]$c.x, [int]$c.y, ($null -ne $c.x), [string]$c.pick)
        $r = @{ found = $e.Found; reason = $e.Reason; hwnd = (Hx $e.Hwnd); cls = $e.Cls; done = $e.Done; len = $e.Len; text = $e.Text; seen = $e.Seen }
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
