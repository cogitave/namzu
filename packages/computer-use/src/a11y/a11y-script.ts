/**
 * The Windows side of the accessibility host: one long-lived PowerShell
 * process that compiles a small C# library and answers JSON lines.
 *
 * It exists because every cheaper way of asking Windows "what windows are
 * there, what is in this one, did it change" costs a process start (seconds
 * under WSL) or an uncached accessibility walk (over a second). Resident, the
 * same questions take a fraction of a millisecond to a few milliseconds:
 *
 * - `windows` enumerates the top-level windows with plain Win32 calls (no
 *   accessibility call at all), keeping the visible, un-cloaked, non-tool
 *   ones and, unless asked otherwise, only those without an owner;
 * - `displays` lists the monitors with their work area and scale;
 * - `snapshot` reads one window's accessibility tree with a single cached
 *   subtree request (the controls a person would see, not the raw tree) and
 *   keeps the elements so `identity` and `resolve` can name one and find it
 *   again after the window changed;
 * - `seq` returns a counter of observed changes and, given a window, makes
 *   sure that window is being watched; `wait_change` resolves from events,
 *   not from sleeping: once a change has been seen and the window has been
 *   quiet for `quietMs`, or after `timeoutMs` with none. A window is watched
 *   by accessibility events (structure and property changes of its subtree)
 *   and by system window events scoped to its process (so a new top-level
 *   window of the same program counts). Events are queued on the thread
 *   that received them and never call back into accessibility.
 *
 * Chromium and Electron windows are not read: asking one for its tree turns
 * its accessibility on for the rest of the session, which costs the user
 * speed in an application they did not hand over. `snapshot` refuses with
 * `chromium_not_activated` unless the request sets `allowChromium`, and a
 * wait on one listens to system window events only.
 *
 * Like the presence helper it is handed to PowerShell as a bootstrap that
 * reads this script from its first line of input; the line protocol follows
 * on the same stream, and the process ends when its input closes.
 */
export const A11Y_HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase, System.Web.Extensions
$refs = @(
  [System.Windows.Automation.AutomationElement].Assembly.Location,
  [System.Windows.Automation.TreeScope].Assembly.Location,
  [System.Windows.Rect].Assembly.Location,
  [System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location
)
Add-Type -ReferencedAssemblies $refs -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

public static class NzA {
 const int Version = 1;
 const int RingN = 8192;
 const int MaxSubs = 32;

 // ---- Native ----
 [StructLayout(LayoutKind.Sequential)] struct RC { public int l; public int t; public int r; public int b; }
 [StructLayout(LayoutKind.Sequential)] struct PT { public int x; public int y; }
 [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr h; public uint m; public IntPtr w; public IntPtr l; public uint t; public PT p; }
 [StructLayout(LayoutKind.Sequential)] struct WPL { public int length; public int flags; public int showCmd; public PT minPos; public PT maxPos; public RC normal; }
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct MI { public int size; public RC mon; public RC work; public int flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dev; }
 delegate bool EnumProc(IntPtr h, IntPtr lp);
 delegate bool MonProc(IntPtr mon, IntPtr dc, ref RC r, IntPtr lp);
 delegate void HookProc(IntPtr hook, uint ev, IntPtr hwnd, int obj, int child, uint thread, uint time);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr lp);
 [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h, EnumProc p, IntPtr lp);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint c);
 [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint f);
 [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll", EntryPoint="GetWindowLongW")] static extern int GetWindowLong(IntPtr h, int i);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RC r);
 [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr h, ref WPL p);
 [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonProc p, IntPtr lp);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetMonitorInfoW(IntPtr mon, ref MI mi);
 [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, HookProc p, uint pid, uint thread, uint flags);
 [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
 [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint a, uint b);
 [DllImport("user32.dll")] static extern bool PeekMessage(out MSG m, IntPtr h, uint a, uint b, uint remove);
 [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
 [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
 [DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread, uint msg, IntPtr w, IntPtr l);
 [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr c);
 [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
 [DllImport("dwmapi.dll", EntryPoint="DwmGetWindowAttribute")] static extern int DwmGetInt(IntPtr h, int a, out int v, int n);
 [DllImport("dwmapi.dll", EntryPoint="DwmGetWindowAttribute")] static extern int DwmGetRect(IntPtr h, int a, out RC v, int n);
 [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr mon, int type, out uint dx, out uint dy);
 [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr p, int flags, StringBuilder s, ref int n);
 [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr p, out long create, out long exit, out long kernel, out long user);
 [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
 [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint ms);

 sealed class Cmd : Exception { public string Code; public Cmd(string code, string msg) : base(msg) { Code = code; } }

 // ---- Time, output ----
 static double NowMs() { return Stopwatch.GetTimestamp() * 1000.0 / Stopwatch.Frequency; }
 static readonly object outLock = new object();
 static void Send(string json) { lock (outLock) { Console.Out.Write(json); Console.Out.Write("\n"); Console.Out.Flush(); } }
 static string D(double v) { return v.ToString("0.#", CultureInfo.InvariantCulture); }
 static string Q(string s) {
  if (s == null) return "\"\"";
  StringBuilder b = new StringBuilder(s.Length + 2); b.Append('"');
  foreach (char c in s) {
   if (c == '"') b.Append("\\\""); else if (c == '\\') b.Append("\\\\");
   else if (c == '\n') b.Append("\\n"); else if (c == '\r') b.Append("\\r"); else if (c == '\t') b.Append("\\t");
   else if (c < 0x20 || c == 0x2028 || c == 0x2029) b.Append("\\u").Append(((int)c).ToString("x4"));
   else b.Append(c);
  }
  return b.Append('"').ToString();
 }
 static string IdJson(object id) {
  if (id == null) return "null";
  if (id is string) return Q((string)id);
  try { return Convert.ToInt64(id).ToString(CultureInfo.InvariantCulture); } catch { return "null"; }
 }
 static long seqCtr;
 static string Head(object id, bool ok) { return "{\"id\":" + IdJson(id) + ",\"ok\":" + (ok ? "true" : "false") + ",\"seq\":" + Interlocked.Read(ref seqCtr) + ",\"t\":" + Stopwatch.GetTimestamp(); }
 static void Ok(object id, string body) { Send(Head(id, true) + (string.IsNullOrEmpty(body) ? "" : "," + body) + "}"); }
 static void Fail(object id, string code, string msg) { Send(Head(id, false) + ",\"code\":" + Q(code) + ",\"message\":" + Q(msg) + "}"); }
 static string Describe(Exception e) { return e.GetType().Name + " 0x" + e.HResult.ToString("x8"); }

 // ---- Request helpers ----
 static object Get(Dictionary<string, object> d, string k) { object v; return d != null && d.TryGetValue(k, out v) ? v : null; }
 static long GetL(Dictionary<string, object> d, string k, long def) { object v = Get(d, k); if (v == null) return def; try { return Convert.ToInt64(v); } catch { return def; } }
 static bool GetB(Dictionary<string, object> d, string k, bool def) { object v = Get(d, k); return v is bool ? (bool)v : def; }
 static string GetS(Dictionary<string, object> d, string k) { object v = Get(d, k); return v as string; }
 static long Clamp(long v, long lo, long hi) { return v < lo ? lo : (v > hi ? hi : v); }
 static IntPtr Hw(long h) { return new IntPtr(h); }
 static long HwL(IntPtr h) { return h.ToInt64() & 0xFFFFFFFFL; }
 static IntPtr NeedWindow(Dictionary<string, object> req) {
  long h = GetL(req, "hwnd", 0);
  if (h == 0) throw new Cmd("bad_request", "hwnd is required");
  IntPtr p = Hw(h);
  if (!IsWindow(p)) throw new Cmd("window_gone", "no such window");
  return p;
 }

 // ---- Window facts ----
 static string ClassOf(IntPtr h) { StringBuilder s = new StringBuilder(256); int n = GetClassNameW(h, s, 256); return n > 0 ? s.ToString(0, n) : ""; }
 static string TitleOf(IntPtr h) { StringBuilder s = new StringBuilder(512); int n = GetWindowTextW(h, s, 512); return n > 0 ? s.ToString(0, n) : ""; }
 static bool ChromiumClass(string c) { return c.StartsWith("Chrome_", StringComparison.Ordinal) || c == "MozillaWindowClass" || c == "CefBrowserWindow"; }
 static bool HasChromiumChild(IntPtr h) {
  bool found = false; int seen = 0;
  EnumChildWindows(h, delegate(IntPtr c, IntPtr lp) { seen++; if (ChromiumClass(ClassOf(c))) { found = true; return false; } return seen < 2000; }, IntPtr.Zero);
  return found;
 }
 static uint PidOf(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return pid; }
 static string ProcName(uint pid) {
  IntPtr p = OpenProcess(0x1000, false, pid);
  if (p == IntPtr.Zero) return "";
  try {
   StringBuilder sb = new StringBuilder(520); int n = sb.Capacity;
   if (!QueryFullProcessImageNameW(p, 0, sb, ref n)) return "";
   string s = sb.ToString(0, n); int i = s.LastIndexOf('\\');
   return i >= 0 ? s.Substring(i + 1) : s;
  } finally { CloseHandle(p); }
 }
 static long ProcStart(uint pid) {
  IntPtr p = OpenProcess(0x1000, false, pid);
  if (p == IntPtr.Zero) return 0;
  try { long c, e, k, u; return GetProcessTimes(p, out c, out e, out k, out u) ? c / 10000 : 0; } finally { CloseHandle(p); }
 }
 static bool Cloaked(IntPtr h) { int v; return DwmGetInt(h, 14, out v, 4) == 0 && v != 0; }
 // The windows a person sees as windows: visible, not cloaked (other virtual desktops, suspended apps), not a tool window; without an owner unless asked.
 static bool Listable(IntPtr h, bool includeOwned) {
  if (!IsWindowVisible(h)) return false;
  int ex = GetWindowLong(h, -20);
  if ((ex & 0x80) != 0 && (ex & 0x40000) == 0) return false;
  if (!includeOwned && GetWindow(h, 4) != IntPtr.Zero) return false;
  if (Cloaked(h)) return false;
  return true;
 }
 static RC FrameRect(IntPtr h, bool iconic) {
  RC r;
  if (iconic) { WPL p = new WPL(); p.length = Marshal.SizeOf(typeof(WPL)); if (GetWindowPlacement(h, ref p)) return p.normal; }
  if (DwmGetRect(h, 9, out r, Marshal.SizeOf(typeof(RC))) == 0) return r;
  GetWindowRect(h, out r);
  return r;
 }
 static IntPtr RootOf(IntPtr h) { IntPtr r = GetAncestor(h, 2); return r == IntPtr.Zero ? h : r; }

 static string Windows(Dictionary<string, object> req) {
  bool includeOwned = GetB(req, "includeOwned", false);
  List<IntPtr> found = new List<IntPtr>(); int total = 0;
  EnumWindows(delegate(IntPtr h, IntPtr lp) { total++; if (Listable(h, includeOwned)) found.Add(h); return true; }, IntPtr.Zero);
  IntPtr fg = GetForegroundWindow(); if (fg != IntPtr.Zero) fg = RootOf(fg);
  StringBuilder sb = new StringBuilder("\"windows\":[");
  for (int i = 0; i < found.Count; i++) {
   IntPtr h = found[i]; uint pid = PidOf(h); bool ic = IsIconic(h); RC r = FrameRect(h, ic);
   if (i > 0) sb.Append(',');
   sb.Append("{\"hwnd\":").Append(HwL(h)).Append(",\"pid\":").Append(pid).Append(",\"process\":").Append(Q(ProcName(pid)))
     .Append(",\"title\":").Append(Q(TitleOf(h))).Append(",\"x\":").Append(r.l).Append(",\"y\":").Append(r.t)
     .Append(",\"width\":").Append(r.r - r.l).Append(",\"height\":").Append(r.b - r.t)
     .Append(",\"minimized\":").Append(ic ? "true" : "false").Append(",\"focused\":").Append(h == fg ? "true" : "false")
     .Append(",\"z\":").Append(i).Append('}');
  }
  return sb.Append("],\"total\":").Append(total).ToString();
 }

 static string Displays() {
  StringBuilder sb = new StringBuilder("\"displays\":["); int n = 0;
  EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr mon, IntPtr dc, ref RC rc, IntPtr lp) {
   MI mi = new MI(); mi.size = Marshal.SizeOf(typeof(MI));
   if (!GetMonitorInfoW(mon, ref mi)) return true;
   uint dx = 96, dy = 96;
   try { GetDpiForMonitor(mon, 0, out dx, out dy); } catch { }
   if (dx == 0) dx = 96;
   if (n > 0) sb.Append(',');
   sb.Append("{\"id\":").Append(Q(mi.dev)).Append(",\"index\":").Append(n)
     .Append(",\"x\":").Append(mi.mon.l).Append(",\"y\":").Append(mi.mon.t).Append(",\"width\":").Append(mi.mon.r - mi.mon.l).Append(",\"height\":").Append(mi.mon.b - mi.mon.t)
     .Append(",\"workX\":").Append(mi.work.l).Append(",\"workY\":").Append(mi.work.t).Append(",\"workWidth\":").Append(mi.work.r - mi.work.l).Append(",\"workHeight\":").Append(mi.work.b - mi.work.t)
     .Append(",\"scale\":").Append(D(dx / 96.0)).Append(",\"dpi\":").Append(dx).Append(",\"primary\":").Append((mi.flags & 1) != 0 ? "true" : "false").Append('}');
   n++; return true;
  }, IntPtr.Zero);
  return sb.Append(']').ToString();
 }

 // ---- Events: one counter, one ring, written by the hook thread and the UIA threads, read by the scheduler ----
 // Source: 1 = accessibility event, 2 = system window event. Kind: 1 structure, 2 property, 3 created, 4 destroyed, 5 shown, 6 hidden, 7 name, 8 value, 9 location.
 struct Ev { public long Seq; public double Ms; public int Src; public int Kind; public long Hwnd; public long Root; public uint Pid; public bool Top; }
 static readonly object evLock = new object();
 static readonly Ev[] ring = new Ev[RingN];
 static bool dirty;
 static int KindBit(int kind) { return (kind == 1 || (kind >= 3 && kind <= 6)) ? 1 : (kind == 9 ? 4 : 2); }
 static void AddEv(int src, int kind, long hwnd, long root, uint pid, bool top) {
  lock (evLock) {
   long s = Interlocked.Increment(ref seqCtr);
   Ev e = new Ev(); e.Seq = s; e.Ms = NowMs(); e.Src = src; e.Kind = kind; e.Hwnd = hwnd; e.Root = root; e.Pid = pid; e.Top = top;
   ring[(int)(s % RingN)] = e; dirty = true; Monitor.PulseAll(evLock);
  }
 }

 // ---- System window events: a hook per watched process, on one thread that pumps messages ----
 sealed class HookCmd { public bool Install; public uint Pid; public IntPtr Handle; public ManualResetEvent Done = new ManualResetEvent(false); }
 static readonly Queue<HookCmd> hookQ = new Queue<HookCmd>();
 static readonly Dictionary<uint, IntPtr> hooks = new Dictionary<uint, IntPtr>();
 static readonly Dictionary<IntPtr, uint> hookPid = new Dictionary<IntPtr, uint>();
 static readonly ManualResetEvent hookReady = new ManualResetEvent(false);
 static uint hookThreadId;
 static readonly HookProc hookDelegate = new HookProc(OnWinEvent);
 static void OnWinEvent(IntPtr hook, uint ev, IntPtr hwnd, int obj, int child, uint thread, uint time) {
  try {
   int kind;
   switch (ev) {
    case 0x8000: kind = 3; break; case 0x8001: kind = 4; break; case 0x8002: kind = 5; break; case 0x8003: kind = 6; break;
    case 0x800B: kind = 9; break; case 0x800C: kind = 7; break; case 0x800E: kind = 8; break;
    default: return;
   }
   if (hwnd == IntPtr.Zero || obj == -9 || obj == -8) return;
   uint pid = 0; lock (hookQ) { if (!hookPid.TryGetValue(hook, out pid)) pid = 0; }
   if (pid == 0) pid = PidOf(hwnd);
   IntPtr root = GetAncestor(hwnd, 2);
   bool gone = root == IntPtr.Zero;
   if (gone) root = hwnd;
   bool top = obj == 0 && !gone && root == hwnd && GetAncestor(hwnd, 1) == GetDesktopWindow();
   AddEv(2, kind, HwL(hwnd), HwL(root), pid, top);
  } catch { }
 }
 static void HookMain() {
  MSG m; PeekMessage(out m, IntPtr.Zero, 0, 0, 0);
  hookThreadId = GetCurrentThreadId(); hookReady.Set();
  while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) {
   if (m.m == 0x8001) {
    while (true) {
     HookCmd c; lock (hookQ) { if (hookQ.Count == 0) break; c = hookQ.Dequeue(); }
     try {
      if (c.Install) { c.Handle = SetWinEventHook(0x8000, 0x800E, IntPtr.Zero, hookDelegate, c.Pid, 0, 2); if (c.Handle != IntPtr.Zero) lock (hookQ) hookPid[c.Handle] = c.Pid; }
      else if (c.Handle != IntPtr.Zero) { UnhookWinEvent(c.Handle); lock (hookQ) hookPid.Remove(c.Handle); }
     } catch { }
     c.Done.Set();
    }
   } else { TranslateMessage(ref m); DispatchMessage(ref m); }
  }
 }
 static void HookCall(HookCmd c) {
  lock (hookQ) hookQ.Enqueue(c);
  PostThreadMessage(hookThreadId, 0x8001, IntPtr.Zero, IntPtr.Zero);
  c.Done.WaitOne(3000);
 }
 static void EnsureHook(uint pid) {
  lock (hookQ) { if (hooks.ContainsKey(pid)) return; }
  HookCmd c = new HookCmd(); c.Install = true; c.Pid = pid; HookCall(c);
  if (c.Handle == IntPtr.Zero) throw new Cmd("hook_failed", "could not watch the process");
  lock (hookQ) hooks[pid] = c.Handle;
 }
 static void DropHook(uint pid) {
  IntPtr h; lock (hookQ) { if (!hooks.TryGetValue(pid, out h)) return; hooks.Remove(pid); }
  HookCmd c = new HookCmd(); c.Install = false; c.Handle = h; HookCall(c);
 }

 // ---- Accessibility events: registered once per window, on the worker thread; the handlers only record ----
 sealed class Sub { public long Hwnd; public uint Pid; public bool Uia; public AutomationElement El; public StructureChangedEventHandler Sh; public AutomationPropertyChangedEventHandler Ph; public long Used; }
 static readonly Dictionary<long, Sub> subs = new Dictionary<long, Sub>();
 static readonly object subLock = new object();
 static long useCtr;
 static Sub Armed(long hwnd) { lock (subLock) { Sub s; if (subs.TryGetValue(hwnd, out s)) { s.Used = ++useCtr; return s; } } return null; }
 static void Unsub(Sub s) {
  if (s.Uia) {
   try { Automation.RemoveStructureChangedEventHandler(s.El, s.Sh); } catch { }
   try { Automation.RemoveAutomationPropertyChangedEventHandler(s.El, s.Ph); } catch { }
  }
 }
 // Worker thread only.
 static Sub Arm(long hwnd) {
  Sub have = Armed(hwnd); if (have != null) return have;
  IntPtr h = Hw(hwnd);
  if (!IsWindow(h)) throw new Cmd("window_gone", "no such window");
  uint pid = PidOf(h);
  EnsureHook(pid);
  Sub n = new Sub(); n.Hwnd = hwnd; n.Pid = pid; n.Used = ++useCtr;
  if (!ChromiumClass(ClassOf(h))) {
   n.El = AutomationElement.FromHandle(h);
   long hw = hwnd;
   n.Sh = delegate(object sender, StructureChangedEventArgs a) { AddEv(1, 1, hw, hw, pid, false); };
   n.Ph = delegate(object sender, AutomationPropertyChangedEventArgs a) { AddEv(1, 2, hw, hw, pid, false); };
   Automation.AddStructureChangedEventHandler(n.El, TreeScope.Subtree, n.Sh);
   Automation.AddAutomationPropertyChangedEventHandler(n.El, TreeScope.Subtree, n.Ph,
    new AutomationProperty[] { AutomationElement.NameProperty, AutomationElement.IsEnabledProperty, AutomationElement.IsOffscreenProperty,
     TogglePattern.ToggleStateProperty, ExpandCollapsePattern.ExpandCollapseStateProperty, ValuePattern.ValueProperty, SelectionItemPattern.IsSelectedProperty });
   n.Uia = true;
  }
  List<Sub> drop = new List<Sub>();
  lock (subLock) {
   subs[hwnd] = n;
   foreach (KeyValuePair<long, Sub> kv in subs) if (kv.Key != hwnd && !IsWindow(Hw(kv.Key))) drop.Add(kv.Value);
   while (subs.Count - drop.Count > MaxSubs) {
    Sub oldest = null;
    foreach (KeyValuePair<long, Sub> kv in subs) if (kv.Key != hwnd && !drop.Contains(kv.Value) && (oldest == null || kv.Value.Used < oldest.Used)) oldest = kv.Value;
    if (oldest == null) break; drop.Add(oldest);
   }
   foreach (Sub d in drop) subs.Remove(d.Hwnd);
  }
  foreach (Sub d in drop) {
   Unsub(d);
   bool still = false; lock (subLock) { foreach (Sub o in subs.Values) if (o.Pid == d.Pid) still = true; }
   if (!still) DropHook(d.Pid);
  }
  return n;
 }

 // ---- Waiting for a change ----
 sealed class Waiter {
  public object Id; public long Hwnd; public uint Pid; public long Since; public long ScanSeq; public double StartMs; public double FirstMs = -1; public double LastMs = -1;
  public double QuietMs; public double TimeoutMs; public int Kinds; public int Count; public List<long> NewWins = new List<long>();
 }
 static readonly List<Waiter> waiters = new List<Waiter>();
 static bool Match(Ev e, Waiter w) {
  if ((KindBit(e.Kind) & w.Kinds) == 0) return false;
  if (e.Src == 1) return e.Hwnd == w.Hwnd;
  if (e.Root == w.Hwnd) return true;
  return e.Pid == w.Pid && e.Top && (e.Kind >= 3 && e.Kind <= 6);
 }
 // Under evLock.
 static void Scan(Waiter w, double now) {
  long cur = Interlocked.Read(ref seqCtr);
  long from = w.ScanSeq + 1;
  if (cur - from >= RingN) { w.Count++; if (w.FirstMs < 0) w.FirstMs = now; w.LastMs = now; from = cur - RingN + 1; }
  for (long s = from; s <= cur; s++) {
   Ev e = ring[(int)(s % RingN)];
   if (e.Seq != s || !Match(e, w)) continue;
   w.Count++; if (w.FirstMs < 0 || e.Ms < w.FirstMs) w.FirstMs = e.Ms; if (e.Ms > w.LastMs) w.LastMs = e.Ms;
   if (e.Root != w.Hwnd && e.Top && (e.Kind == 3 || e.Kind == 5) && !w.NewWins.Contains(e.Root)) w.NewWins.Add(e.Root);
  }
  w.ScanSeq = cur;
 }
 static string ChangedBody(Waiter w, double now, bool settled) {
  StringBuilder sb = new StringBuilder("\"changed\":true,\"settled\":" + (settled ? "true" : "false") + ",\"firstEventMs\":" + D(w.FirstMs - w.StartMs) + ",\"settledMs\":" + D(now - w.StartMs) + ",\"events\":" + w.Count + ",\"newWindows\":[");
  bool first = true;
  foreach (long id in w.NewWins) { IntPtr h = Hw(id); if (!IsWindow(h) || !Listable(h, true)) continue; if (!first) sb.Append(','); first = false; sb.Append(id); }
  return sb.Append(']').ToString();
 }
 static void StartWait(object id, Dictionary<string, object> req) {
  IntPtr h = NeedWindow(req);
  Waiter w = new Waiter(); w.Id = id; w.Hwnd = HwL(h); w.Pid = PidOf(h);
  w.QuietMs = Clamp(GetL(req, "quietMs", 120), 5, 5000);
  w.TimeoutMs = Clamp(GetL(req, "timeoutMs", 2000), 20, 10000);
  int kinds = 0; object ks = Get(req, "kinds");
  System.Collections.IEnumerable list = ks as System.Collections.IEnumerable;
  if (list != null && !(ks is string)) foreach (object k in list) { string s = k as string; if (s == "structure") kinds |= 1; else if (s == "property") kinds |= 2; else if (s == "location") kinds |= 4; }
  w.Kinds = kinds == 0 ? 7 : kinds;
  w.StartMs = NowMs();
  w.Since = GetL(req, "since", -1);
  bool armed = Armed(w.Hwnd) != null;
  lock (evLock) {
   long cur = Interlocked.Read(ref seqCtr);
   if (w.Since < 0 || w.Since > cur) w.Since = cur;
   w.ScanSeq = w.Since; waiters.Add(w); dirty = true; Monitor.PulseAll(evLock);
  }
  // A window that was not yet watched is armed now, behind the wait; the wait still ends on time.
  if (!armed) Enqueue(null, delegate() { Arm(w.Hwnd); return null; }, 8000, delegate(Exception e) {
   Cmd c = e as Cmd; lock (evLock) { waiters.Remove(w); }
   Fail(w.Id, c != null ? c.Code : "error", c != null ? c.Message : Describe(e));
  });
 }

 // ---- Worker: every accessibility call runs on one MTA thread; one that hangs is abandoned and replaced ----
 sealed class Job { public object Id; public Func<string> Fn; public int TimeoutMs; public double StartMs; public int Replied; public Action<Exception> OnError; }
 static readonly Queue<Job> jobs = new Queue<Job>();
 static readonly object qLock = new object();
 static Job current;
 static int workerGen;
 static void Enqueue(object id, Func<string> fn, int timeoutMs, Action<Exception> onError) {
  Job j = new Job(); j.Id = id; j.Fn = fn; j.TimeoutMs = timeoutMs; j.OnError = onError;
  lock (qLock) { jobs.Enqueue(j); Monitor.PulseAll(qLock); }
 }
 static void StartWorker() {
  int gen; lock (qLock) { gen = ++workerGen; }
  Thread t = new Thread(delegate() { WorkerMain(gen); });
  t.SetApartmentState(ApartmentState.MTA); t.IsBackground = true; t.Name = "nz-a11y-worker"; t.Start();
 }
 static void WorkerMain(int gen) {
  try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch { }
  while (true) {
   Job j;
   lock (qLock) {
    while (jobs.Count == 0 && gen == workerGen) Monitor.Wait(qLock);
    if (gen != workerGen) return;
    j = jobs.Dequeue(); current = j; j.StartMs = NowMs();
   }
   string body = null; Exception err = null;
   try { body = j.Fn(); } catch (Exception e) { err = e; }
   lock (qLock) { if (current == j) current = null; }
   if (Interlocked.Exchange(ref j.Replied, 1) == 0) {
    if (err != null) {
     if (j.OnError != null) j.OnError(err);
     else { Cmd c = err as Cmd; Fail(j.Id, c != null ? c.Code : "uia_error", c != null ? c.Message : Describe(err)); }
    } else if (body != null) Ok(j.Id, body);
   }
   if (gen != workerGen) return;
  }
 }
 static void Watchdog(double now) {
  Job stuck = null;
  lock (qLock) {
   if (current != null && now - current.StartMs > current.TimeoutMs) { stuck = current; current = null; }
  }
  if (stuck == null) return;
  // The stuck thread is left to finish on its own; a fresh worker takes over the queue.
  StartWorker();
  lock (qLock) { Monitor.PulseAll(qLock); }
  if (Interlocked.Exchange(ref stuck.Replied, 1) == 0) {
   if (stuck.OnError != null) stuck.OnError(new Cmd("timeout", "the window did not answer in time"));
   else Fail(stuck.Id, "timeout", "the window did not answer in time");
  }
 }
 static void SchedMain() {
  while (true) {
   List<KeyValuePair<object, string>> out2 = new List<KeyValuePair<object, string>>();
   double sleep = 50;
   lock (evLock) {
    double now = NowMs();
    for (int i = waiters.Count - 1; i >= 0; i--) {
     Waiter w = waiters[i];
     Scan(w, now);
     string body = null;
     if (w.Count > 0 && now - w.LastMs >= w.QuietMs) body = ChangedBody(w, now, true);
     else if (now - w.StartMs >= w.TimeoutMs) body = w.Count > 0 ? ChangedBody(w, now, false) : "\"changed\":false,\"timedOut\":true,\"settledMs\":" + D(now - w.StartMs);
     if (body != null) { waiters.RemoveAt(i); out2.Add(new KeyValuePair<object, string>(w.Id, body)); }
     else {
      double due = w.StartMs + w.TimeoutMs;
      if (w.Count > 0) due = Math.Min(due, w.LastMs + w.QuietMs);
      sleep = Math.Min(sleep, Math.Max(0.5, due - now));
     }
    }
   }
   foreach (KeyValuePair<object, string> r in out2) Ok(r.Key, r.Value);
   Watchdog(NowMs());
   lock (evLock) { if (!dirty) Monitor.Wait(evLock, (int)Math.Ceiling(sleep)); dirty = false; }
   Thread.Sleep(1);
  }
 }

 // ---- Snapshot ----
 sealed class Nd {
  public AutomationElement El; public int Index; public int Parent; public int Depth; public string Role; public string Name; public string Aid; public string Cls;
  public int X; public int Y; public int W; public int H; public bool En; public bool Off; public bool Foc; public List<string> Act = new List<string>();
  public string Val; public string Tog; public string Exp; public int Sel = -1; public int ChildCount = -1; public int[] Rid; public string Tag; public string Path; public int Ord;
 }
 sealed class Snap { public long Rev; public long Hwnd; public uint Pid; public List<Nd> Nodes; }
 static readonly Dictionary<long, Snap> snaps = new Dictionary<long, Snap>();
 static long revCtr;
 static string Fnv(string s) { uint h = 2166136261; foreach (char c in s) { h ^= c; h *= 16777619; } return h.ToString("x8"); }
 static string RidStr(int[] r) { if (r == null) return ""; StringBuilder b = new StringBuilder(); for (int i = 0; i < r.Length; i++) { if (i > 0) b.Append('.'); b.Append(r[i]); } return b.ToString(); }
 static CacheRequest NewCache(TreeScope scope) {
  CacheRequest cr = new CacheRequest();
  cr.TreeFilter = Automation.ControlViewCondition; cr.TreeScope = scope;
  cr.Add(AutomationElement.NameProperty); cr.Add(AutomationElement.ControlTypeProperty); cr.Add(AutomationElement.AutomationIdProperty); cr.Add(AutomationElement.ClassNameProperty);
  cr.Add(AutomationElement.BoundingRectangleProperty); cr.Add(AutomationElement.IsEnabledProperty); cr.Add(AutomationElement.IsOffscreenProperty);
  cr.Add(AutomationElement.HasKeyboardFocusProperty); cr.Add(AutomationElement.RuntimeIdProperty); cr.Add(AutomationElement.IsPasswordProperty);
  cr.Add(AutomationElement.IsInvokePatternAvailableProperty); cr.Add(AutomationElement.IsValuePatternAvailableProperty); cr.Add(AutomationElement.IsTogglePatternAvailableProperty);
  cr.Add(AutomationElement.IsExpandCollapsePatternAvailableProperty); cr.Add(AutomationElement.IsSelectionItemPatternAvailableProperty); cr.Add(AutomationElement.IsScrollPatternAvailableProperty);
  cr.Add(ValuePattern.Pattern); cr.Add(ValuePattern.ValueProperty); cr.Add(ValuePattern.IsReadOnlyProperty);
  cr.Add(TogglePattern.Pattern); cr.Add(TogglePattern.ToggleStateProperty);
  cr.Add(ExpandCollapsePattern.Pattern); cr.Add(ExpandCollapsePattern.ExpandCollapseStateProperty);
  cr.Add(SelectionItemPattern.Pattern); cr.Add(SelectionItemPattern.IsSelectedProperty);
  return cr;
 }
 static bool Avail(AutomationElement e, AutomationProperty p) { object v = e.GetCachedPropertyValue(p); return v is bool && (bool)v; }
 static Nd Make(AutomationElement e, int parent, int depth) {
  Nd n = new Nd(); n.El = e; n.Parent = parent; n.Depth = depth;
  AutomationElement.AutomationElementInformation c = e.Cached;
  string role = c.ControlType.ProgrammaticName; n.Role = role.StartsWith("ControlType.", StringComparison.Ordinal) ? role.Substring(12) : role;
  string name = c.Name ?? ""; n.Name = name.Length > 120 ? name.Substring(0, 120) : name;
  n.Aid = c.AutomationId ?? ""; n.Cls = c.ClassName ?? "";
  System.Windows.Rect r = c.BoundingRectangle;
  if (r.IsEmpty || double.IsInfinity(r.X) || double.IsInfinity(r.Width)) { n.X = 0; n.Y = 0; n.W = 0; n.H = 0; }
  else { n.X = (int)Math.Round(r.X); n.Y = (int)Math.Round(r.Y); n.W = (int)Math.Round(r.Width); n.H = (int)Math.Round(r.Height); }
  n.En = c.IsEnabled; n.Off = c.IsOffscreen; n.Foc = c.HasKeyboardFocus;
  try { n.Rid = (int[])e.GetCachedPropertyValue(AutomationElement.RuntimeIdProperty); } catch { }
  object po;
  if (Avail(e, AutomationElement.IsInvokePatternAvailableProperty)) n.Act.Add("invoke");
  if (Avail(e, AutomationElement.IsValuePatternAvailableProperty)) {
   n.Act.Add("value");
   bool pw = false; try { object v = e.GetCachedPropertyValue(AutomationElement.IsPasswordProperty); pw = v is bool && (bool)v; } catch { }
   if (!pw && e.TryGetCachedPattern(ValuePattern.Pattern, out po)) { string val = ((ValuePattern)po).Cached.Value ?? ""; n.Val = val.Length > 120 ? val.Substring(0, 120) : val; }
  }
  if (Avail(e, AutomationElement.IsTogglePatternAvailableProperty)) {
   n.Act.Add("toggle");
   if (e.TryGetCachedPattern(TogglePattern.Pattern, out po)) { ToggleState ts = ((TogglePattern)po).Cached.ToggleState; n.Tog = ts == ToggleState.On ? "on" : (ts == ToggleState.Off ? "off" : "mixed"); }
  }
  if (Avail(e, AutomationElement.IsExpandCollapsePatternAvailableProperty)) {
   n.Act.Add("expandCollapse");
   if (e.TryGetCachedPattern(ExpandCollapsePattern.Pattern, out po)) { ExpandCollapseState xs = ((ExpandCollapsePattern)po).Cached.ExpandCollapseState; n.Exp = xs == ExpandCollapseState.Expanded ? "expanded" : (xs == ExpandCollapseState.Collapsed ? "collapsed" : (xs == ExpandCollapseState.PartiallyExpanded ? "partial" : "leaf")); }
  }
  if (Avail(e, AutomationElement.IsSelectionItemPatternAvailableProperty)) {
   n.Act.Add("selectionItem");
   if (e.TryGetCachedPattern(SelectionItemPattern.Pattern, out po)) n.Sel = ((SelectionItemPattern)po).Cached.IsSelected ? 1 : 0;
  }
  if (Avail(e, AutomationElement.IsScrollPatternAvailableProperty)) n.Act.Add("scroll");
  n.Tag = n.Role + ":" + Fnv(name);
  return n;
 }
 static int ChildrenOf(AutomationElement e, out AutomationElementCollection kids) {
  try { kids = e.CachedChildren; return kids.Count; } catch (InvalidOperationException) { kids = null; return -1; }
 }
 sealed class WalkCtx { public List<Nd> Nodes = new List<Nd>(); public int Max; public int MaxDepth; public int Total; public bool Truncated; public Dictionary<int, Dictionary<string, int>> Ords = new Dictionary<int, Dictionary<string, int>>(); }
 static void Walk(AutomationElement e, int parent, int depth, WalkCtx x) {
  x.Total++;
  if (x.Nodes.Count >= x.Max || depth > x.MaxDepth) { x.Truncated = true; AutomationElementCollection skip; int cnt = ChildrenOf(e, out skip); if (cnt > 0) foreach (AutomationElement k in skip) WalkCount(k, x); return; }
  Nd n = Make(e, parent, depth); n.Index = x.Nodes.Count; x.Nodes.Add(n);
  if (parent >= 0) {
   Nd p = x.Nodes[parent]; n.Path = p.Path.Length == 0 ? p.Tag : p.Path + "/" + p.Tag;
   Dictionary<string, int> oc; if (!x.Ords.TryGetValue(parent, out oc)) { oc = new Dictionary<string, int>(); x.Ords[parent] = oc; }
   int o; oc.TryGetValue(n.Tag, out o); n.Ord = o; oc[n.Tag] = o + 1;
  } else n.Path = "";
  AutomationElementCollection kids; int count = ChildrenOf(e, out kids);
  if (count < 0) return;
  int before = x.Nodes.Count;
  foreach (AutomationElement k in kids) Walk(k, n.Index, depth + 1, x);
  if (x.Nodes.Count - before < count || depth + 1 > x.MaxDepth) n.ChildCount = count;
 }
 static void WalkCount(AutomationElement e, WalkCtx x) {
  x.Total++; AutomationElementCollection kids; int c = ChildrenOf(e, out kids);
  if (c > 0) foreach (AutomationElement k in kids) WalkCount(k, x);
 }
 // The shallow read: the window, its children and theirs, one request per second-level container.
 static WalkCtx Skeleton(AutomationElement root, int max) {
  WalkCtx x = new WalkCtx(); x.Max = max; x.MaxDepth = 2;
  CacheRequest cr = NewCache(TreeScope.Element | TreeScope.Children);
  AutomationElement top = root.GetUpdatedCache(cr);
  x.Total = 1; Nd rn = Make(top, -1, 0); rn.Index = 0; rn.Path = ""; x.Nodes.Add(rn);
  AutomationElementCollection kids; int count = ChildrenOf(top, out kids);
  rn.ChildCount = count > 0 ? count : -1;
  if (count > 0) foreach (AutomationElement k in kids) {
   if (x.Nodes.Count >= x.Max) { x.Truncated = true; x.Total++; continue; }
   AutomationElement kc = k.GetUpdatedCache(cr); x.Total++;
   Nd kn = Make(kc, 0, 1); kn.Index = x.Nodes.Count; kn.Path = rn.Tag; x.Nodes.Add(kn);
   AutomationElementCollection gk; int gc = ChildrenOf(kc, out gk);
   if (gc > 0) { kn.ChildCount = gc; foreach (AutomationElement g in gk) {
    x.Total++;
    if (x.Nodes.Count >= x.Max) { x.Truncated = true; continue; }
    Nd gn = Make(g, kn.Index, 2); gn.Index = x.Nodes.Count; gn.Path = rn.Tag + "/" + kn.Tag; x.Nodes.Add(gn);
   } }
  }
  return x;
 }
 static void NodeJson(StringBuilder sb, Nd n) {
  sb.Append("{\"index\":").Append(n.Index).Append(",\"parent\":").Append(n.Parent).Append(",\"depth\":").Append(n.Depth).Append(",\"role\":").Append(Q(n.Role));
  if (n.Name.Length > 0) sb.Append(",\"name\":").Append(Q(n.Name));
  if (n.Aid.Length > 0) sb.Append(",\"automationId\":").Append(Q(n.Aid));
  if (n.Cls.Length > 0) sb.Append(",\"className\":").Append(Q(n.Cls));
  sb.Append(",\"rect\":[").Append(n.X).Append(',').Append(n.Y).Append(',').Append(n.W).Append(',').Append(n.H).Append(']');
  sb.Append(",\"enabled\":").Append(n.En ? "true" : "false");
  if (n.Off) sb.Append(",\"offscreen\":true");
  if (n.Foc) sb.Append(",\"focused\":true");
  if (n.Act.Count > 0) { sb.Append(",\"actions\":["); for (int i = 0; i < n.Act.Count; i++) { if (i > 0) sb.Append(','); sb.Append(Q(n.Act[i])); } sb.Append(']'); }
  if (n.Val != null) sb.Append(",\"value\":").Append(Q(n.Val));
  if (n.Tog != null) sb.Append(",\"toggle\":").Append(Q(n.Tog));
  if (n.Exp != null) sb.Append(",\"expand\":").Append(Q(n.Exp));
  if (n.Sel >= 0) sb.Append(",\"selected\":").Append(n.Sel == 1 ? "true" : "false");
  if (n.ChildCount >= 0) sb.Append(",\"childCount\":").Append(n.ChildCount);
  sb.Append('}');
 }
 static void RefuseChromium(IntPtr h, Dictionary<string, object> req) {
  if (GetB(req, "allowChromium", false)) return;
  if (ChromiumClass(ClassOf(h)) || HasChromiumChild(h)) throw new Cmd("chromium_not_activated", "this window is a Chromium or Electron one; reading it would turn its accessibility on");
 }
 static Snap ReadSnap(IntPtr h, int max, int maxDepth, bool skeleton, out WalkCtx ctx, out double readMs) {
  double t0 = NowMs();
  AutomationElement root = AutomationElement.FromHandle(h);
  if (skeleton) ctx = Skeleton(root, max);
  else {
   AutomationElement top = root.GetUpdatedCache(NewCache(TreeScope.Subtree));
   ctx = new WalkCtx(); ctx.Max = max; ctx.MaxDepth = maxDepth;
   Walk(top, -1, 0, ctx);
  }
  readMs = NowMs() - t0;
  Snap s = new Snap(); s.Rev = Interlocked.Increment(ref revCtr); s.Hwnd = HwL(h); s.Pid = PidOf(h); s.Nodes = ctx.Nodes;
  lock (subLock) {
   snaps[s.Hwnd] = s;
   while (snaps.Count > 6) { long oldest = -1; foreach (KeyValuePair<long, Snap> kv in snaps) if (oldest < 0 || kv.Value.Rev < snaps[oldest].Rev) oldest = kv.Key; if (oldest == s.Hwnd) break; snaps.Remove(oldest); }
  }
  return s;
 }
 static string Snapshot(Dictionary<string, object> req) {
  IntPtr h = NeedWindow(req);
  RefuseChromium(h, req);
  bool skeleton = GetB(req, "skeleton", false);
  int max = (int)Clamp(GetL(req, "maxNodes", 400), 1, 5000), depth = (int)Clamp(GetL(req, "maxDepth", 12), 0, 64);
  WalkCtx x; double readMs;
  Snap s = ReadSnap(h, max, depth, skeleton, out x, out readMs);
  double e0 = NowMs();
  StringBuilder sb = new StringBuilder("\"hwnd\":" + HwL(h) + ",\"rev\":" + s.Rev + ",\"skeleton\":" + (skeleton ? "true" : "false") + ",\"total\":" + x.Total + ",\"truncated\":" + (x.Truncated ? "true" : "false") + ",\"readMs\":" + D(readMs) + ",\"nodes\":[");
  for (int i = 0; i < s.Nodes.Count; i++) { if (i > 0) sb.Append(','); NodeJson(sb, s.Nodes[i]); }
  return sb.Append("],\"emitMs\":").Append(D(NowMs() - e0)).ToString();
 }
 static Snap Latest(long hwnd) { lock (subLock) { Snap s; if (snaps.TryGetValue(hwnd, out s)) return s; } return null; }
 static string Identity(Dictionary<string, object> req) {
  IntPtr h = NeedWindow(req);
  Snap s = Latest(HwL(h));
  if (s == null) throw new Cmd("no_snapshot", "take a snapshot of the window first");
  long rev = GetL(req, "rev", -1);
  if (rev >= 0 && rev != s.Rev) throw new Cmd("stale_snapshot", "the window was read again since");
  long idx = GetL(req, "index", -1);
  if (idx < 0 || idx >= s.Nodes.Count) throw new Cmd("bad_index", "no such node");
  Nd n = s.Nodes[(int)idx];
  return "\"fingerprint\":{\"runtimeId\":" + Q(RidStr(n.Rid)) + ",\"automationId\":" + Q(n.Aid) + ",\"role\":" + Q(n.Role) + ",\"nameHash\":" + Q(n.Tag.Substring(n.Tag.IndexOf(':') + 1)) + ",\"parentPath\":" + Q(n.Path) + ",\"ordinal\":" + n.Ord + ",\"processStart\":" + ProcStart(s.Pid) + "}";
 }
 static string Resolve(Dictionary<string, object> req) {
  IntPtr h = NeedWindow(req);
  Dictionary<string, object> f = Get(req, "fingerprint") as Dictionary<string, object>;
  if (f == null) throw new Cmd("bad_request", "fingerprint is required");
  string rid = GetS(f, "runtimeId") ?? "", aid = GetS(f, "automationId") ?? "", role = GetS(f, "role") ?? "", nh = GetS(f, "nameHash") ?? "", path = GetS(f, "parentPath") ?? "";
  long ord = GetL(f, "ordinal", -1), pstart = GetL(f, "processStart", 0);
  if (pstart != 0) { long now = ProcStart(PidOf(h)); if (now != 0 && now != pstart) return "\"found\":false,\"code\":\"not_found\""; }
  WalkCtx x; double readMs;
  Snap s = ReadSnap(h, 5000, 64, false, out x, out readMs);
  List<Nd> hits = new List<Nd>(); string via = "";
  if (rid.Length > 0) { foreach (Nd n in s.Nodes) if (RidStr(n.Rid) == rid) hits.Add(n); if (hits.Count == 1) via = "runtimeId"; else if (hits.Count > 1) return "\"found\":false,\"code\":\"ambiguous\",\"candidates\":" + hits.Count; }
  if (via.Length == 0 && aid.Length > 0) {
   hits.Clear(); foreach (Nd n in s.Nodes) if (n.Aid == aid && n.Role == role) hits.Add(n);
   if (hits.Count > 1) { List<Nd> by = hits.FindAll(delegate(Nd n) { return n.Path == path; }); if (by.Count > 0) hits = by; }
   if (hits.Count > 1 && ord >= 0) { List<Nd> by = hits.FindAll(delegate(Nd n) { return n.Ord == ord; }); if (by.Count > 0) hits = by; }
   if (hits.Count == 1) via = "automationId"; else if (hits.Count > 1) return "\"found\":false,\"code\":\"ambiguous\",\"candidates\":" + hits.Count;
  }
  if (via.Length == 0) {
   hits.Clear(); foreach (Nd n in s.Nodes) if (n.Role == role && n.Tag.EndsWith(":" + nh, StringComparison.Ordinal) && n.Path == path) hits.Add(n);
   if (hits.Count > 1 && ord >= 0) { List<Nd> by = hits.FindAll(delegate(Nd n) { return n.Ord == ord; }); if (by.Count > 0) hits = by; }
   if (hits.Count == 1) via = "name"; else if (hits.Count > 1) return "\"found\":false,\"code\":\"ambiguous\",\"candidates\":" + hits.Count;
  }
  if (via.Length == 0) return "\"found\":false,\"code\":\"not_found\"";
  return "\"found\":true,\"index\":" + hits[0].Index + ",\"via\":" + Q(via) + ",\"rev\":" + s.Rev + ",\"total\":" + x.Total + ",\"readMs\":" + D(readMs);
 }

 // ---- The loop ----
 static string Hello() { return "\"hello\":true,\"version\":" + Version + ",\"pid\":" + Process.GetCurrentProcess().Id + ",\"freq\":" + Stopwatch.Frequency + ",\"capabilities\":[\"windows\",\"displays\",\"snapshot\",\"seq\",\"wait_change\",\"identity\",\"resolve\"]"; }
 static void Handle(string line) {
  object id = null;
  try {
   Dictionary<string, object> req = new JavaScriptSerializer().DeserializeObject(line) as Dictionary<string, object>;
   if (req == null) throw new Cmd("bad_request", "not an object");
   id = Get(req, "id");
   int to = (int)Clamp(GetL(req, "timeoutMs", 8000), 500, 30000);
   switch (GetS(req, "cmd")) {
    case "hello": Ok(id, Hello()); break;
    case "windows": Ok(id, Windows(req)); break;
    case "displays": Ok(id, Displays()); break;
    case "seq": {
     long hw = GetL(req, "hwnd", 0);
     if (hw == 0 || Armed(hw) != null) { Ok(id, "\"armed\":" + (hw != 0 ? "true" : "false")); break; }
     NeedWindow(req);
     Enqueue(id, delegate() { Arm(hw); return "\"armed\":true"; }, 8000, null);
     break;
    }
    case "snapshot": Enqueue(id, delegate() { return Snapshot(req); }, to, null); break;
    case "identity": Enqueue(id, delegate() { return Identity(req); }, to, null); break;
    case "resolve": Enqueue(id, delegate() { return Resolve(req); }, to, null); break;
    case "wait_change": StartWait(id, req); break;
    case "quit": Ok(id, ""); Environment.Exit(0); break;
    default: Fail(id, "unknown_command", "unknown command"); break;
   }
  } catch (Cmd c) { Fail(id, c.Code, c.Message); }
  catch (Exception e) { Fail(id, "error", Describe(e)); }
 }
 public static void Run() {
  timeBeginPeriod(1);
  try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
  Thread hk = new Thread(HookMain); hk.IsBackground = true; hk.Name = "nz-a11y-hook"; hk.Start();
  hookReady.WaitOne(3000);
  StartWorker();
  Thread sc = new Thread(SchedMain); sc.IsBackground = true; sc.Name = "nz-a11y-sched"; sc.Start();
  Send(Head(null, true) + "," + Hello() + "}");
  string line;
  while ((line = Console.In.ReadLine()) != null) { if (line.Length > 0) Handle(line); }
  Environment.Exit(0);
 }
}
'@
[NzA]::Run()
`

/**
 * The script is longer than a Windows command line allows once encoded, so
 * PowerShell is started with this short bootstrap, which reads the script as
 * its first line of input (UTF-8, base64) and runs it; the line protocol
 * follows on the same stream.
 */
export const A11Y_BOOTSTRAP =
	'$s=[Console]::In.ReadLine();Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)))'

/** The first line to write to a helper started with {@link A11Y_BOOTSTRAP}. */
export function a11yScriptLine(script: string = A11Y_HELPER_SCRIPT): string {
	return Buffer.from(script, 'utf8').toString('base64')
}
