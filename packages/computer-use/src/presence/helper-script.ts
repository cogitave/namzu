/**
 * The Windows side of the presence overlay: one long-lived PowerShell process
 * that owns two small windows and draws them itself.
 *
 * - the agent cursor, a pixel-art arrow in the project's green with a dark
 *   outline, that glides to each action point in {@link GLIDE_MS} and pulses on
 *   a click or on typing;
 * - the presence border, a frame inside the operated window made of an
 *   ordered (Bayer) dither that thins towards the middle, which follows the
 *   window and fades out a while after the last action.
 *
 * Both windows are layered, click-through (`WS_EX_TRANSPARENT`), never
 * activated (`WS_EX_NOACTIVATE`), kept out of the taskbar and alt-tab
 * (`WS_EX_TOOLWINDOW`) and excluded from every screen capture
 * (`SetWindowDisplayAffinity` with `WDA_EXCLUDEFROMCAPTURE`). If the exclusion
 * cannot be set the helper shows nothing: an overlay that could end up in the
 * model's own screenshot is worse than none. They are placed directly above
 * the operated window in the z-order, never raised above others, so a window
 * behind other windows gets its cursor and border without coming forward.
 *
 * Like the foreground helper it is handed to PowerShell as an encoded command
 * and speaks one JSON object per line in each direction; its input closing
 * ends it, and its windows go with it.
 */
export const GLIDE_MS = 120
/** How long the border and cursor stay after the last action, then fade. */
export const HOLD_MS = 2_500
export const FADE_MS = 600

export const PRESENCE_HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @"
using System; using System.Diagnostics; using System.Runtime.InteropServices; using System.Threading;
public static class NzP {
 [StructLayout(LayoutKind.Sequential)] struct PT { public int x; public int y; }
 [StructLayout(LayoutKind.Sequential)] struct SZ { public int cx; public int cy; }
 [StructLayout(LayoutKind.Sequential)] struct RC { public int l; public int t; public int r; public int b; }
 [StructLayout(LayoutKind.Sequential)] struct BF { public byte op; public byte fl; public byte a; public byte fmt; }
 [StructLayout(LayoutKind.Sequential)] struct BMI { public int size; public int w; public int h; public short planes; public short bits; public int comp; public int img; public int xp; public int yp; public int used; public int imp; }
 [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr h; public uint m; public IntPtr w; public IntPtr l; public uint t; public PT p; }
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct WC { public uint size; public uint style; public IntPtr proc; public int cb; public int wb; public IntPtr inst; public IntPtr icon; public IntPtr cur; public IntPtr bg; public string menu; public string cls; public IntPtr small; }
 delegate IntPtr WP(IntPtr h, uint m, IntPtr w, IntPtr l);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern ushort RegisterClassEx(ref WC c);
 [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateWindowEx(uint ex, string cls, string name, uint st, int x, int y, int w, int h, IntPtr par, IntPtr menu, IntPtr inst, IntPtr p);
 [DllImport("user32.dll")] static extern IntPtr DefWindowProc(IntPtr h, uint m, IntPtr w, IntPtr l);
 [DllImport("user32.dll")] static extern bool UpdateLayeredWindow(IntPtr h, IntPtr dst, ref PT pd, ref SZ sz, IntPtr src, ref PT ps, uint key, ref BF bf, uint fl);
 [DllImport("user32.dll", SetLastError=true)] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int cy, uint fl);
 [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint c);
 [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
 [DllImport("user32.dll", SetLastError=true)] static extern bool SetWindowDisplayAffinity(IntPtr h, uint a);
 [DllImport("user32.dll")] static extern bool GetWindowDisplayAffinity(IntPtr h, out uint a);
 [DllImport("user32.dll")] static extern UIntPtr SetTimer(IntPtr h, UIntPtr id, uint ms, IntPtr f);
 [DllImport("user32.dll")] static extern bool KillTimer(IntPtr h, UIntPtr id);
 [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
 [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint a, uint b);
 [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
 [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int i, int v);
 [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW", SetLastError=true)] static extern IntPtr SetWindowLongPtr64(IntPtr h, int i, IntPtr v);
 [DllImport("user32.dll", EntryPoint="SetWindowLongW", SetLastError=true)] static extern int SetWindowLongPtr32(IntPtr h, int i, int v);
 [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
 [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
 [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
 [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, ref BMI bmi, uint u, out IntPtr bits, IntPtr sec, uint off);
 [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
 [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
 [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
 [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RC r, int n);
 [DllImport("kernel32.dll")] static extern void SetLastError(uint e);
 [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string n);

 const uint EX = 0x20 | 0x08000000 | 0x80;
 static readonly string[] Sprite = {
  "#...........","##..........","#g#.........","#gg#........","#ggg#.......","#gggg#......","#ggggg#.....","#gggggg#....","#ggggggg#...",
  "#gggggggg#..","#ggggg#####.","#gg#gg#.....","#g#.#gg#....","##..#gg#....","#....#gg#...",".....#gg#...","......##...."
 };
 static readonly int[] Bayer = { 0,8,2,10, 12,4,14,6, 3,11,1,9, 15,7,13,5 };
 const int S = 3, PAD = 36, CW = 100, CH = 110, T = 8, CELL = 2;
 static readonly double[] Dens = { 1.0, 0.62, 0.38, 0.16 };
 const int GREEN = 0x5fff5f, INK = 0x0b0f0c;

 static IntPtr frm, cur, mem1, mem2, bmp1, bmp2, bits1, bits2; static WP proc;
 static int fw, fh, lastX, lastY, lastW, lastH; static IntPtr lastPrev;
 public static long Hwnd1, Hwnd2; public static bool Excluded, Ready; public static string Err = "";
 static ManualResetEvent ready = new ManualResetEvent(false);
 static object gate = new object();
 // Command state (written by the reader thread, read by the UI thread).
 static IntPtr target; static double ax, ay; static bool hasPoint; static int kind; static long actTick; static bool hidden = true;
 // Animation state (UI thread only).
 static double rx, ry, fx, fy, tx, ty; static long glideAt = -1000; static long pulseAt = -10000; static int pulseKind; static bool placed;
 static int lastAlpha = -1; static bool borderDrawn; static IntPtr drawnFor;
 public static long Ticks, TickUs, MaxTickUs; static Stopwatch sw = Stopwatch.StartNew();
 static bool timerOn; static long refuseUntil; public static int Refused;
 public static int GlideMs = ${GLIDE_MS}, HoldMs = ${HOLD_MS}, FadeMs = ${FADE_MS};

 static long Now() { return sw.ElapsedMilliseconds; }
 static IntPtr Wnd(IntPtr h, uint m, IntPtr w, IntPtr l) {
  if (m == 0x113) { try { Tick(); } catch (Exception e) { Err = e.Message; } return IntPtr.Zero; }
  if (m == 0x8000) { try { Tick(); } catch (Exception e) { Err = e.Message; } return IntPtr.Zero; }
  return DefWindowProc(h, m, w, l);
 }
 static IntPtr Make(string cls, ref uint aff) {
  IntPtr h = CreateWindowEx(EX, cls, "", 0x80000000, 0, 0, 1, 1, IntPtr.Zero, IntPtr.Zero, GetModuleHandle(null), IntPtr.Zero);
  if (h == IntPtr.Zero) throw new Exception("CreateWindowEx " + Marshal.GetLastWin32Error());
  // Windows refuses the exclusion on a window that is already layered, so it is
  // set first and the layered style added after; the setting survives.
  bool set = SetWindowDisplayAffinity(h, 0x11); int le = Marshal.GetLastWin32Error();
  SetWindowLong(h, -20, GetWindowLong(h, -20) | 0x80000);
  if (!set) throw new Exception("capture exclusion unavailable " + le);
  uint a; GetWindowDisplayAffinity(h, out a); aff = a;
  return h;
 }
 static IntPtr Dib(int w, int h, out IntPtr mem, out IntPtr bits) {
  IntPtr sd = GetDC(IntPtr.Zero); mem = CreateCompatibleDC(sd);
  BMI b = new BMI(); b.size = 40; b.w = w; b.h = -h; b.planes = 1; b.bits = 32;
  IntPtr bm = CreateDIBSection(sd, ref b, 0, out bits, IntPtr.Zero, 0); ReleaseDC(IntPtr.Zero, sd);
  SelectObject(mem, bm); return bm;
 }
 public static bool Start() {
  var t = new Thread(() => {
   try {
    proc = Wnd; WC c = new WC(); c.size = (uint)Marshal.SizeOf(typeof(WC)); c.proc = Marshal.GetFunctionPointerForDelegate(proc); c.inst = GetModuleHandle(null); c.cls = "NzPresence";
    RegisterClassEx(ref c);
    uint a1 = 0, a2 = 0;
    frm = Make("NzPresence", ref a1); cur = Make("NzPresence", ref a2);
    Hwnd1 = (long)frm; Hwnd2 = (long)cur; Excluded = a1 == 0x11 && a2 == 0x11;
    if (!Excluded) throw new Exception("capture exclusion not applied");
    bmp2 = Dib(CW, CH, out mem2, out bits2);
    Ready = true; ready.Set();
    MSG m; while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { DispatchMessage(ref m); }
   } catch (Exception e) { Err = e.Message; ready.Set(); }
  });
  t.IsBackground = true; t.SetApartmentState(ApartmentState.STA); t.Start();
  ready.WaitOne(10000); return Ready;
 }
 // Called from the reader thread.
 public static void Act(long hwnd, double x, double y, bool point, int k) {
  lock (gate) {
   IntPtr h = (IntPtr)hwnd; if (h != target) { target = h; placed = false; borderDrawn = false; }
   hasPoint = point; ax = x; ay = y; kind = k; actTick = Now(); hidden = false; pending = true;
  }
  PostMessage(frm, 0x8000, IntPtr.Zero, IntPtr.Zero);
 }
 static bool pending;
 public static void Hide() { lock (gate) { hidden = true; pending = true; } PostMessage(frm, 0x8000, IntPtr.Zero, IntPtr.Zero); }
 static void HideNow() {
  ShowWindow(frm, 0); ShowWindow(cur, 0); lastW = 0; lastH = 0; lastPrev = IntPtr.Zero; lastAlpha = -1;
  if (timerOn) { KillTimer(frm, (UIntPtr)1); timerOn = false; }
 }
 // An owned window stays directly above its owner in the z-order whatever else moves, in front of or behind other windows, without raising the owner.
 static bool Own(IntPtr w, IntPtr owner) {
  SetLastError(0);
  long r = IntPtr.Size == 8 ? (long)SetWindowLongPtr64(w, -8, owner) : SetWindowLongPtr32(w, -8, (int)owner);
  return r != 0 || Marshal.GetLastWin32Error() == 0;
 }
 static IntPtr ownedBy;
 static bool Overlaps(IntPtr h, RC r) { RC o; if (!Rect(h, out o)) return true; return o.l < r.r && o.r > r.l && o.t < r.b && o.b > r.t; }
 static bool Rect(IntPtr h, out RC r) { return DwmGetWindowAttribute(h, 9, out r, 16) == 0 && r.r > r.l && r.b > r.t; }
 static void Tick() {
  long t0 = sw.ElapsedTicks; IntPtr tg; bool hid, hp, ch; double px, py; int k; long at;
  lock (gate) { tg = target; hid = hidden; hp = hasPoint; px = ax; py = ay; k = kind; at = actTick; ch = pending; pending = false; }
  if (hid || tg == IntPtr.Zero || !IsWindow(tg) || IsIconic(tg) || !IsWindowVisible(tg)) { HideNow(); return; }
  RC r; if (!Rect(tg, out r)) { HideNow(); return; }
  long now = Now(); int w = r.r - r.l, h = r.b - r.t;
  double age = now - at, alpha = 1.0;
  if (age > HoldMs) alpha = 1.0 - (age - HoldMs) / FadeMs;
  if (alpha <= 0) { lock (gate) { hidden = true; } HideNow(); return; }
  if (now < refuseUntil) return;
  if (!timerOn) { SetTimer(frm, (UIntPtr)1, 16, IntPtr.Zero); timerOn = true; }
  if (ch && hp) {
   // New action point in window coordinates: relative to the window's rectangle.
   px -= r.l; py -= r.t; fx = placed ? rx : px; fy = placed ? ry : py; tx = px; ty = py; glideAt = now; placed = true; if (k != 0) { pulseAt = now; pulseKind = k; }
  } else if (ch) {
   if (k != 0) { pulseAt = now; pulseKind = k; }
   if (!placed) { tx = w / 2.0; ty = h / 2.0; fx = tx; fy = ty; rx = tx; ry = ty; placed = true; glideAt = -1000; }
  }
  if (placed) {
   double u = (now - glideAt) / (double)GlideMs; if (u > 1) u = 1; if (u < 0) u = 0;
   double e = 1 - Math.Pow(1 - u, 3); rx = fx + (tx - fx) * e; ry = fy + (ty - fy) * e;
  }
  // z-order: directly above the operated window, never above others.
  IntPtr prev = GetWindow(tg, 3);
  // Windows that are not shown (input-method helpers and the like) sit in bands of their own: ordering against them has no effect.
  // A window that does not overlap the operated one cannot hide it, so ordering against it is not needed.
  while (prev != IntPtr.Zero && (prev == frm || prev == cur || !IsWindowVisible(prev) || !Overlaps(prev, r))) prev = GetWindow(prev, 3);
  // The operated window can move up past the overlay (it is raised, or the window above it closes): the overlay must be right above it again.
  bool moved = r.l != lastX || r.t != lastY || w != lastW || h != lastH || prev != lastPrev || Steps(frm, tg) < 0;
  bool fresh = lastW == 0;
  if (w != fw || h != fh || !borderDrawn || drawnFor != tg) DrawBorder(w, h, tg);
  int a = (int)(alpha * 255);
  if (moved || fresh || a != lastAlpha) {
   PT pd = new PT(); pd.x = r.l; pd.y = r.t; SZ sz = new SZ(); sz.cx = w; sz.cy = h; PT ps = new PT();
   BF bf = new BF(); bf.op = 0; bf.fl = 0; bf.a = (byte)a; bf.fmt = 1;
   UpdateLayeredWindow(frm, IntPtr.Zero, ref pd, ref sz, mem1, ref ps, 0, ref bf, 2);
   lastAlpha = a;
  }
  // The cursor window follows the glide; its sprite tip sits at the window's (PAD,PAD).
  double sx = r.l + rx, sy = r.t + ry;
  if (sx < r.l) sx = r.l; if (sy < r.t) sy = r.t; if (sx > r.r - 1) sx = r.r - 1; if (sy > r.b - 1) sy = r.b - 1;
  DrawCursor(now, (int)Math.Round(sx) - PAD, (int)Math.Round(sy) - PAD, alpha);
  uint fl = 0x10 | 0x40; // NOACTIVATE | SHOWWINDOW
  if (ownedBy != tg) { ownedBy = Own(frm, tg) && Own(cur, tg) ? tg : IntPtr.Zero; moved = true; }
  if (moved || fresh) {
   int cx = (int)Math.Round(sx) - PAD, cy = (int)Math.Round(sy) - PAD;
   if (ownedBy == tg) {
    // Windows keeps an owned window above its owner; only the position and visibility are set here.
    SetWindowPos(frm, IntPtr.Zero, r.l, r.t, 0, 0, fl | 0x1 | 0x4);
    SetWindowPos(cur, IntPtr.Zero, cx, cy, 0, 0, fl | 0x1 | 0x4);
   } else {
    IntPtr ins = prev != IntPtr.Zero ? prev : ((GetWindowLong(tg, -20) & 8) != 0 ? (IntPtr)(-1) : IntPtr.Zero); // top of its band when it is in front
    SetWindowPos(frm, ins, r.l, r.t, 0, 0, fl | 0x1);
    SetWindowPos(cur, frm, cx, cy, 0, 0, fl | 0x1);
   }
   // A layered window shown for the first time takes its picture again.
   if (fresh) { PT p2 = new PT(); p2.x = r.l; p2.y = r.t; SZ s2 = new SZ(); s2.cx = w; s2.cy = h; PT q2 = new PT(); BF b2 = new BF(); b2.fmt = 1; b2.a = (byte)a; UpdateLayeredWindow(frm, IntPtr.Zero, ref p2, ref s2, mem1, ref q2, 0, ref b2, 2); }
   lastX = r.l; lastY = r.t; lastW = w; lastH = h; lastPrev = prev;
   // A window the overlay cannot be ordered against gets no overlay at all: a frame hidden
   // behind its window is worse than none.
   if (!IsWindowVisible(frm) || Steps(frm, tg) < 0) { ShowWindow(frm, 0); ShowWindow(cur, 0); lastW = 0; refuseUntil = now + 500; Refused++; }
  }
  long us = (sw.ElapsedTicks - t0) * 1000000 / Stopwatch.Frequency;
  Ticks++; TickUs += us; if (us > MaxTickUs) MaxTickUs = us;
 }
 static void DrawBorder(int w, int h, IntPtr tg) {
  if (bmp1 != IntPtr.Zero) { SelectObject(mem1, IntPtr.Zero); DeleteObject(bmp1); DeleteDC(mem1); }
  bmp1 = Dib(w, h, out mem1, out bits1); fw = w; fh = h; drawnFor = tg; borderDrawn = true;
  int[] px = new int[w * h]; int g = unchecked((int)(0xFF000000 | GREEN));
  for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
   int d = Math.Min(Math.Min(x, w - 1 - x), Math.Min(y, h - 1 - y)); if (d >= T) { if (y >= T && y < h - T) { x = w - T - 1; } continue; }
   int c = d / CELL; int cx = x / CELL, cy = y / CELL;
   if (Bayer[(cy & 3) * 4 + (cx & 3)] < Dens[c] * 16) px[y * w + x] = g;
  }
  Marshal.Copy(px, 0, bits1, w * h); lastAlpha = -1;
 }
 static void Put(int[] b, int x, int y, int argb) { if (x >= 0 && y >= 0 && x < CW && y < CH) b[y * CW + x] = argb; }
 static int Pre(int rgb, int a) {
  int r = ((rgb >> 16) & 255) * a / 255, g = ((rgb >> 8) & 255) * a / 255, b = (rgb & 255) * a / 255;
  return (a << 24) | (r << 16) | (g << 8) | b;
 }
 static void DrawCursor(long now, int x, int y, double alpha) {
  int[] b = new int[CW * CH];
  // Pulse: a square pixel ring that grows and fades around the tip.
  double pu = (now - pulseAt) / 360.0;
  if (pu >= 0 && pu < 1) {
   int rad = (pulseKind == 2 ? 6 : 8) + (int)(pu * (pulseKind == 2 ? 14 : 22)) / 2 * 2; int a = (int)((1 - pu) * 230);
   for (int i = -rad; i <= rad; i += 2) {
    foreach (int[] p in new int[][] { new int[]{i,-rad}, new int[]{i,rad}, new int[]{-rad,i}, new int[]{rad,i} }) {
     int bx = PAD + p[0], by = PAD + p[1];
     if (Bayer[(((by / 2) & 3) * 4) + ((bx / 2) & 3)] < 11) { for (int dy = 0; dy < 2; dy++) for (int dx = 0; dx < 2; dx++) Put(b, bx + dx, by + dy, Pre(GREEN, a)); }
    }
   }
  }
  for (int sy = 0; sy < Sprite.Length; sy++) for (int sx = 0; sx < Sprite[sy].Length; sx++) {
   char c = Sprite[sy][sx]; if (c == '.') continue;
   int col = c == '#' ? INK : GREEN;
   for (int dy = 0; dy < S; dy++) for (int dx = 0; dx < S; dx++) Put(b, PAD + sx * S + dx, PAD + sy * S + dy, Pre(col, 255));
  }
  Marshal.Copy(b, 0, bits2, CW * CH);
  PT pd = new PT(); pd.x = x; pd.y = y; SZ sz = new SZ(); sz.cx = CW; sz.cy = CH; PT ps = new PT();
  BF bf = new BF(); bf.op = 0; bf.fl = 0; bf.a = (byte)(alpha * 255); bf.fmt = 1;
  UpdateLayeredWindow(cur, IntPtr.Zero, ref pd, ref sz, mem2, ref ps, 0, ref bf, 2);
 }
 static int Steps(IntPtr from, IntPtr to) { IntPtr w = from; for (int i = 0; i < 400 && w != IntPtr.Zero; i++) { if (w == to) return i; w = GetWindow(w, 2); } return -1; }
 public static string Info() {
  uint a1, a2; GetWindowDisplayAffinity(frm, out a1); GetWindowDisplayAffinity(cur, out a2);
  return "{\"frame\":\"0x" + Hwnd1.ToString("X") + "\",\"cursor\":\"0x" + Hwnd2.ToString("X") + "\",\"affinity\":[" + a1 + "," + a2 + "],\"ex\":[" + (uint)GetWindowLong(frm, -20) + "," + (uint)GetWindowLong(cur, -20) + "],\"above\":" + (Steps(frm, target) >= 0 ? "true" : "false") + ",\"fvis\":" + (IsWindowVisible(frm) ? 1 : 0) + ",\"cvis\":" + (IsWindowVisible(cur) ? 1 : 0) + ",\"lastAlpha\":" + lastAlpha + ",\"fwh\":\"" + fw + "x" + fh + " last " + lastW + "x" + lastH + " at " + lastX + "," + lastY + "\",\"owned\":" + (ownedBy == target ? "true" : "false") + ",\"refused\":" + Refused + ",\"err\":\"" + Err.Replace("\"", "'") + "\",\"ticks\":" + Ticks + ",\"avgTickUs\":" + (Ticks == 0 ? 0 : TickUs / Ticks) + ",\"maxTickUs\":" + MaxTickUs + ",\"foreground\":\"0x" + ((long)GetForegroundWindow()).ToString("X") + "\"}";
 }
}
"@
$ok = [NzP]::Start()
function Reply($o) { [Console]::Out.WriteLine((ConvertTo-Json -InputObject $o -Compress -Depth 6)) }
Reply @{ ok = $ok; excluded = [NzP]::Excluded; error = [NzP]::Err }
if (-not $ok) { exit 1 }
while (($line = [Console]::In.ReadLine()) -ne $null) {
  $cid = $null
  try {
    $c = $line | ConvertFrom-Json
    $cid = $c.id
    switch ($c.cmd) {
      'act' {
        $h = [Convert]::ToInt64(([string]$c.hwnd).Substring(2), 16)
        $has = ($null -ne $c.x -and $null -ne $c.y)
        $k = if ($c.kind -eq 'type') { 2 } elseif ($c.kind -eq 'move') { 0 } else { 1 }
        [NzP]::Act($h, [double]$(if ($has) { $c.x } else { 0 }), [double]$(if ($has) { $c.y } else { 0 }), $has, $k)
        $r = @{ ok = $true }
      }
      'hide' { [NzP]::Hide(); $r = @{ ok = $true } }
      'info' { $r = ([NzP]::Info() | ConvertFrom-Json) }
      'quit' { break }
      default { $r = @{ error = 'unknown command' } }
    }
    if ($c.cmd -eq 'quit') { break }
    Reply @{ ok = $true; id = $cid; r = $r }
  } catch {
    Reply @{ ok = $false; id = $cid; error = "$_" }
  }
}
`

/**
 * The script is longer than a Windows command line allows once encoded, so
 * PowerShell is started with this short bootstrap, which reads the script as
 * its first line of input (UTF-8, base64) and runs it; the line protocol
 * follows on the same stream.
 */
export const PRESENCE_BOOTSTRAP =
	'$s=[Console]::In.ReadLine();Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)))'

/** The first line to write to a helper started with {@link PRESENCE_BOOTSTRAP}. */
export function presenceScriptLine(script: string = PRESENCE_HELPER_SCRIPT): string {
	return Buffer.from(script, 'utf8').toString('base64')
}
