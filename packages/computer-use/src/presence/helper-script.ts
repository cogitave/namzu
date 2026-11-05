import {
	APPEAR_FROM_SCALE,
	APPEAR_MS,
	CLICK_RIPPLE,
	DIP_DOWN_MS,
	DIP_SCALE,
	DIP_UP_MS,
	FADE_MS,
	FRAME_PULSE_DEPTH,
	FRAME_PULSE_MS,
	GLIDE_BOW,
	GLIDE_MAX_MS,
	GLIDE_MIN_MS,
	GLIDE_MS_PER_PX,
	HOLD_MS,
	KEY_RIPPLE,
	RIPPLE_MS,
} from './motion.js'

export {
	APPEAR_MS,
	FADE_MS,
	GLIDE_MAX_MS,
	GLIDE_MIN_MS,
	HOLD_MS,
	RIPPLE_MS,
} from './motion.js'

/**
 * The Windows side of the presence overlay: one long-lived PowerShell process
 * that owns two small windows and draws them itself.
 *
 * - the agent cursor, a smooth anti-aliased arrow in the project's green with
 *   a dark outline, a soft highlight and a soft shadow, drawn once per display
 *   scale and composited at sub-pixel positions. It fades in on its first
 *   appearance, glides along a gentle curve to each action point (140 to
 *   420 ms by distance), dips on a click and sends out a circular ripple (a
 *   smaller one for typing);
 * - the presence border, a smooth rounded frame inside the operated window
 *   (a green stroke with a soft glow inward), which follows the window, breathes
 *   very gently while the cursor is active and fades out with it.
 *
 * Sizes are written in logical pixels and multiplied by the operated window's
 * display scale (its DPI over 96). The numbers and the formulas are in
 * `motion.ts`; the C# below follows them. Nothing is redrawn when nothing moves:
 * the 16 ms timer only compares, and bitmaps are allocated once per size.
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
 * ends it, and its windows go with it. Besides `act`, `hide`, `info` and `quit`
 * it answers `preview`, a development aid that draws one state of the overlay
 * into a PNG without showing a window (see `preview.ts`).
 */
export const PRESENCE_HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System; using System.Collections.Generic; using System.Diagnostics; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.Runtime.InteropServices; using System.Threading;
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
 [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
 [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
 [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
 [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, ref BMI bmi, uint u, out IntPtr bits, IntPtr sec, uint off);
 [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
 [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
 [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
 [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RC r, int n);
 [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
 [DllImport("kernel32.dll")] static extern void SetLastError(uint e);
 [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string n);

 const uint EX = 0x20 | 0x08000000 | 0x80;

 // ---- Design, in logical px; every size is multiplied by the window's display scale. ----
 // The cursor window reaches Pad around the tip (room for the ripple and the shadow).
 const double Pad = 32, SprMargin = 8, SprRight = 20, SprDown = 32;
 const double ShadowDx = 1.5, ShadowDy = 2.5, ShadowBlur = 4, ShadowA = 0.32;
 const double OutlineW = 1.25;
 const double FrameStroke = 2, FrameGlow = 8, FrameRadius = 8, FrameStrokeA = 0.65, FrameGlowA = 0.30;
 const int AccentR = 0x34, AccentG = 0xd3, AccentB = 0x69;
 // The arrow: x, y (tip at 0,0) and the radius that rounds each corner.
 static readonly float[][] Arrow = {
  new float[]{0f, 0f, 1.1f}, new float[]{0f, 18.8f, 1.3f}, new float[]{4.5f, 15.2f, 0.9f}, new float[]{7.7f, 21.6f, 1.2f},
  new float[]{11.2f, 20.1f, 1.2f}, new float[]{8.0f, 15.2f, 0.9f}, new float[]{14.0f, 15.2f, 1.3f}
 };

 // ---- Motion (the numbers and formulas are in motion.ts). ----
 const int GlideMinMs = ${GLIDE_MIN_MS}, GlideMaxMs = ${GLIDE_MAX_MS}, AppearMs = ${APPEAR_MS}, DipDownMs = ${DIP_DOWN_MS}, DipUpMs = ${DIP_UP_MS}, RippleMs = ${RIPPLE_MS}, FramePulseMs = ${FRAME_PULSE_MS};
 const double GlideMsPerPx = ${GLIDE_MS_PER_PX}, GlideBow = ${GLIDE_BOW}, AppearFrom = ${APPEAR_FROM_SCALE}, DipScale = ${DIP_SCALE}, PulseDepth = ${FRAME_PULSE_DEPTH};
 const double ClickFrom = ${CLICK_RIPPLE.from}, ClickTo = ${CLICK_RIPPLE.to}, ClickA = ${CLICK_RIPPLE.alpha}, ClickW = ${CLICK_RIPPLE.stroke};
 const double KeyFrom = ${KEY_RIPPLE.from}, KeyTo = ${KEY_RIPPLE.to}, KeyA = ${KEY_RIPPLE.alpha}, KeyW = ${KEY_RIPPLE.stroke};
 public static int HoldMs = ${HOLD_MS}, FadeMs = ${FADE_MS};

 sealed class Spr { public Bitmap Bmp; public double Tx; public double Ty; public int W; public int H; }
 static Dictionary<int, Spr> sprites = new Dictionary<int, Spr>();

 static IntPtr frm, cur, mem1, mem2, bmp1, bmp2, bits1, bits2; static WP proc;
 static int fw, fh, lastX, lastY, lastW, lastH; static IntPtr lastPrev;
 public static long Hwnd1, Hwnd2; public static bool Excluded, Ready; public static string Err = "";
 static ManualResetEvent ready = new ManualResetEvent(false);
 static object gate = new object();
 // Command state (written by the reader thread, read by the UI thread).
 static IntPtr target; static double ax, ay; static bool hasPoint; static int kind; static bool hidden = true, pending, retarget;
 // Animation state (UI thread only). Positions are physical pixels from the operated window's corner.
 static double rx, ry, fx, fy, tx, ty, kx, ky; static long glideAt = -100000; static int glideDur; static long appearAt = -100000, pressAt = -100000, holdFrom; static int pressKind; static bool placed;
 // What is drawn now, to tell whether anything changed.
 static int lastAlpha = -1; static long lastPush = -1000; static bool borderDrawn; static IntPtr drawnFor; static double frameScale;
 static Bitmap curBmp; static Graphics curG; static int curW, curPad; static double curScale; static bool curDirty = true;
 static double dSx = -1e9, dSy = -1e9, dSc, dRr, dRa, dRw; static int dA = -1, dRk = -1;
 static int[] frameBuf;
 public static long Ticks, TickUs, MaxTickUs; static Stopwatch sw = Stopwatch.StartNew();
 static bool timerOn; static long refuseUntil; public static int Refused;

 static long Now() { return sw.ElapsedMilliseconds; }
 static double Clamp(double v, double lo, double hi) { return v < lo ? lo : (v > hi ? hi : v); }
 static double EaseInOut(double u) { u = Clamp(u, 0, 1); return u < 0.5 ? 4 * u * u * u : 1 - Math.Pow(-2 * u + 2, 3) / 2; }
 static double EaseOut(double u) { u = Clamp(u, 0, 1); return 1 - Math.Pow(1 - u, 3); }
 static int GlideDuration(double logical) { return (int)Math.Round(Clamp(GlideMinMs + logical * GlideMsPerPx, GlideMinMs, GlideMaxMs)); }
 // The middle of the path moved sideways by GlideBow of its length, always to the same side of the line (up; right for a vertical one), whichever way it is travelled.
 static void Control(double x0, double y0, double x1, double y1, out double cx, out double cy) {
  double dx = x1 - x0, dy = y1 - y0, len = Math.Sqrt(dx * dx + dy * dy);
  cx = (x0 + x1) / 2; cy = (y0 + y1) / 2; if (len < 1e-9) return;
  double nx = -dy / len, ny = dx / len;
  if (ny > 1e-9 || (Math.Abs(ny) <= 1e-9 && nx < 0)) { nx = -nx; ny = -ny; }
  cx += nx * len * GlideBow; cy += ny * len * GlideBow;
 }
 static double Dip(double ms) {
  if (ms < 0 || ms >= DipDownMs + DipUpMs) return 1;
  if (ms < DipDownMs) return 1 - (1 - DipScale) * EaseOut(ms / DipDownMs);
  return DipScale + (1 - DipScale) * EaseOut((ms - DipDownMs) / DipUpMs);
 }
 // The ripple k (1 click, 2 key) ms after it lands; false before it and once faded.
 static bool Ripple(int k, double ms, out double radius, out double alpha, out double stroke) {
  radius = 0; alpha = 0; stroke = 0;
  if (k == 0 || ms < 0 || ms >= RippleMs) return false;
  double p = ms / RippleMs, from = k == 2 ? KeyFrom : ClickFrom, to = k == 2 ? KeyTo : ClickTo;
  radius = from + (to - from) * EaseOut(p); alpha = (k == 2 ? KeyA : ClickA) * (1 - p); stroke = k == 2 ? KeyW : ClickW;
  return true;
 }
 static double ScaleOf(IntPtr h) { try { uint d = GetDpiForWindow(h); return d == 0 ? 1.0 : d / 96.0; } catch (Exception) { return 1.0; } }

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
    // Physical pixels: the frame bounds come from the window manager in physical units, and a
    // DPI-unaware thread would have them scaled again on a display set above 100%.
    try { SetThreadDpiAwarenessContext((IntPtr)(-4)); } catch (Exception) { }
    proc = Wnd; WC c = new WC(); c.size = (uint)Marshal.SizeOf(typeof(WC)); c.proc = Marshal.GetFunctionPointerForDelegate(proc); c.inst = GetModuleHandle(null); c.cls = "NzPresence";
    RegisterClassEx(ref c);
    uint a1 = 0, a2 = 0;
    frm = Make("NzPresence", ref a1); cur = Make("NzPresence", ref a2);
    Hwnd1 = (long)frm; Hwnd2 = (long)cur; Excluded = a1 == 0x11 && a2 == 0x11;
    if (!Excluded) throw new Exception("capture exclusion not applied");
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
   IntPtr h = (IntPtr)hwnd; if (h != target) { target = h; retarget = true; }
   hasPoint = point; ax = x; ay = y; kind = k; hidden = false; pending = true;
  }
  PostMessage(frm, 0x8000, IntPtr.Zero, IntPtr.Zero);
 }
 public static void Hide() { lock (gate) { hidden = true; pending = true; } PostMessage(frm, 0x8000, IntPtr.Zero, IntPtr.Zero); }
 static void HideNow() {
  ShowWindow(frm, 0); ShowWindow(cur, 0); lastW = 0; lastH = 0; lastPrev = IntPtr.Zero; lastAlpha = -1; curDirty = true; placed = false; pressKind = 0;
  if (timerOn) { KillTimer(frm, (UIntPtr)1); timerOn = false; }
 }
 // An owned window stays directly above its owner in the z-order whatever else moves, in front of or behind other windows, without raising the owner.
 static bool Own(IntPtr w, IntPtr owner) {
  SetLastError(0);
  long r = IntPtr.Size == 8 ? (long)SetWindowLongPtr64(w, -8, owner) : SetWindowLongPtr32(w, -8, (int)owner);
  return r != 0 || Marshal.GetLastWin32Error() == 0;
 }
 static IntPtr ownedBy;
 // A window without a frame rectangle (a hidden application window) covers nothing.
 static bool Overlaps(IntPtr h, RC r) { RC o; if (!Rect(h, out o)) return false; return o.l < r.r && o.r > r.l && o.t < r.b && o.b > r.t; }
 static bool Rect(IntPtr h, out RC r) { return DwmGetWindowAttribute(h, 9, out r, 16) == 0 && r.r > r.l && r.b > r.t; }

 // A new action, on the UI thread: where the pointer goes, how it gets there and when its press lands.
 static void Begin(long now, RC r, int w, int h, double px, double py, bool hp, int k, bool retargeted, double s) {
  long arrive = now; bool appear = !placed || retargeted;
  if (hp) {
   px = Clamp(px - r.l, 0, w - 1); py = Clamp(py - r.t, 0, h - 1);
   if (appear) { fx = px; fy = py; tx = px; ty = py; rx = px; ry = py; glideDur = 0; }
   else {
    fx = rx; fy = ry; tx = px; ty = py;
    double dist = Math.Sqrt((tx - fx) * (tx - fx) + (ty - fy) * (ty - fy)) / s;
    if (dist < 0.5) glideDur = 0; else { glideDur = GlideDuration(dist); Control(fx, fy, tx, ty, out kx, out ky); }
    glideAt = now; arrive = now + glideDur;
   }
  } else if (appear) { tx = w / 2.0; ty = h / 2.0; fx = tx; fy = ty; rx = tx; ry = ty; glideDur = 0; }
  else if (glideAt + glideDur > now) arrive = glideAt + glideDur;
  if (appear) { appearAt = now; arrive = now + AppearMs; placed = true; }
  if (k != 0) { pressAt = arrive; pressKind = k; }
  holdFrom = arrive;
 }

 static void Tick() {
  long t0 = sw.ElapsedTicks; IntPtr tg; bool hid, hp, ch, rt; double px, py; int k;
  lock (gate) { tg = target; hid = hidden; hp = hasPoint; px = ax; py = ay; k = kind; ch = pending; rt = retarget; pending = false; retarget = false; }
  if (hid || tg == IntPtr.Zero || !IsWindow(tg) || IsIconic(tg) || !IsWindowVisible(tg)) { HideNow(); return; }
  RC r; if (!Rect(tg, out r)) { HideNow(); return; }
  long now = Now(); int w = r.r - r.l, h = r.b - r.t;
  double s = ScaleOf(tg);
  if (ch) Begin(now, r, w, h, px, py, hp, k, rt, s);
  double age = now - holdFrom, alpha = 1.0;
  if (age > HoldMs) alpha = 1.0 - (age - HoldMs) / FadeMs;
  if (alpha <= 0) { lock (gate) { hidden = true; } HideNow(); return; }
  if (now < refuseUntil) return;
  if (!timerOn) { SetTimer(frm, (UIntPtr)1, 16, IntPtr.Zero); timerOn = true; }
  // Where the pointer is now: along the curve, eased, in sub-pixels.
  if (placed) {
   double u = glideDur > 0 ? Clamp((now - glideAt) / (double)glideDur, 0, 1) : 1;
   if (u >= 1) { rx = tx; ry = ty; }
   else { double e = EaseInOut(u), b = 1 - e; rx = b * b * fx + 2 * b * e * kx + e * e * tx; ry = b * b * fy + 2 * b * e * ky + e * e * ty; }
  }
  double ap = EaseOut((now - appearAt) / (double)AppearMs);
  double sc = AppearFrom + (1 - AppearFrom) * ap;
  if (pressKind == 1) sc *= Dip(now - pressAt);
  double rr, ra, rw; int rk = 0;
  if (Ripple(pressKind, now - pressAt, out rr, out ra, out rw)) rk = pressKind;
  double sx = Clamp(r.l + rx, r.l, r.r - 1), sy = Clamp(r.t + ry, r.t, r.b - 1);
  int ca = (int)Math.Round(255 * alpha * ap);
  int fa = (int)Math.Round(255 * alpha * ap * (1 - PulseDepth + PulseDepth * Math.Sin(2 * Math.PI * (now % FramePulseMs) / FramePulseMs)));
  EnsureCursor(s);
  // z-order: directly above the operated window, never above others.
  IntPtr prev = GetWindow(tg, 3);
  // Windows that are not shown (input-method helpers and the like) sit in bands of their own: ordering against them has no effect.
  // A window that does not overlap the operated one cannot hide it, so ordering against it is not needed.
  // A window in the other (topmost or not) band is above or below it by band, and an overlay cannot be placed after it without changing band, which Windows refuses for a window owned by one in the other band.
  while (prev != IntPtr.Zero && (prev == frm || prev == cur || !IsWindowVisible(prev) || !Overlaps(prev, r) || (GetWindowLong(prev, -20) & 8) != (GetWindowLong(tg, -20) & 8))) prev = GetWindow(prev, 3);
  // The operated window can move up past the overlay (it is raised, or the window above it closes): the overlay must be right above it again.
  bool moved = r.l != lastX || r.t != lastY || w != lastW || h != lastH || prev != lastPrev || Steps(frm, tg) < 0;
  bool fresh = lastW == 0;
  if (w != fw || h != fh || !borderDrawn || drawnFor != tg || frameScale != s) BuildFrame(w, h, s, tg);
  // The frame's picture is whole; only its opacity breathes, so it is pushed when it moved or its opacity changed enough to see.
  if (moved || fresh || (fa != lastAlpha && now - lastPush >= 33)) PushFrame(r, w, h, fa, now);
  int cx = (int)Math.Floor(sx) - curPad, cy = (int)Math.Floor(sy) - curPad;
  DrawCursor(s, sx - Math.Floor(sx), sy - Math.Floor(sy), sx, sy, sc, rk, rr, ra, rw, ca, cx, cy, fresh);
  uint fl = 0x10 | 0x40; // NOACTIVATE | SHOWWINDOW
  if (ownedBy != tg) { ownedBy = Own(frm, tg) && Own(cur, tg) ? tg : IntPtr.Zero; moved = true; }
  if (moved || fresh) {
   // Ownership keeps an owned window above its owner only when it is raised; it does not reorder
   // windows already stacked above the owner (a target created after the overlay), so the order is
   // set explicitly: right above the operated window, never above others.
   IntPtr ins = prev != IntPtr.Zero ? prev : ((GetWindowLong(tg, -20) & 8) != 0 ? (IntPtr)(-1) : IntPtr.Zero); // top of its band when it is in front
   // Windows refuses to order after some windows (an access error); then the next one up is tried, ending at the top of the band.
   SetLastError(0);
   for (int up = 0; !SetWindowPos(frm, ins, r.l, r.t, 0, 0, fl | 0x1) && ins != IntPtr.Zero && ins != (IntPtr)(-1) && up < 40; up++) ins = GetWindow(ins, 3);
   SetWindowPos(cur, frm, cx, cy, 0, 0, fl | 0x1);
   // A layered window shown for the first time takes its picture again.
   if (fresh) { PushFrame(r, w, h, fa, now); DrawCursor(s, sx - Math.Floor(sx), sy - Math.Floor(sy), sx, sy, sc, rk, rr, ra, rw, ca, cx, cy, true); }
   lastX = r.l; lastY = r.t; lastW = w; lastH = h; lastPrev = prev;
   // A window the overlay cannot be ordered against gets no overlay at all: a frame hidden
   // behind its window is worse than none.
   if (!IsWindowVisible(frm) || Steps(frm, tg) < 0) { ShowWindow(frm, 0); ShowWindow(cur, 0); lastW = 0; refuseUntil = now + 500; Refused++; }
  }
  long us = (sw.ElapsedTicks - t0) * 1000000 / Stopwatch.Frequency;
  Ticks++; TickUs += us; if (us > MaxTickUs) MaxTickUs = us;
 }

 // ---- The frame: a rounded stroke with a soft glow inward, from a distance field (smooth edges, no dithering). ----
 static void BuildFrame(int w, int h, double s, IntPtr tg) {
  if (bmp1 != IntPtr.Zero) { SelectObject(mem1, IntPtr.Zero); DeleteObject(bmp1); DeleteDC(mem1); }
  bmp1 = Dib(w, h, out mem1, out bits1); fw = w; fh = h; drawnFor = tg; frameScale = s; borderDrawn = true;
  int n = w * h; if (frameBuf == null || frameBuf.Length < n) frameBuf = new int[n]; else Array.Clear(frameBuf, 0, n);
  FrameFill(frameBuf, w, h, s);
  Marshal.Copy(frameBuf, 0, bits1, n); lastAlpha = -1;
 }
 // Fills premultiplied pixels for a w x h window: the stroke FrameStroke wide on the inside of a rounded rectangle, then the glow FrameGlow deep fading to nothing.
 static void FrameFill(int[] px, int w, int h, double s) {
  double rad = FrameRadius * s, sw2 = FrameStroke * s, gw = FrameGlow * s;
  int band = (int)Math.Ceiling(sw2 + gw) + 1;
  double cx = w / 2.0, cy = h / 2.0, ex = cx - rad, ey = cy - rad;
  for (int y = 0; y < h; y++) {
   bool edgeRow = y < band || y >= h - band;
   for (int x = 0; x < w; x++) {
    if (!edgeRow && x >= band && x < w - band) { x = w - band - 1; continue; }
    double qx = Math.Abs(x + 0.5 - cx) - ex, qy = Math.Abs(y + 0.5 - cy) - ey;
    double ox = Math.Max(qx, 0), oy = Math.Max(qy, 0);
    double din = -(Math.Sqrt(ox * ox + oy * oy) + Math.Min(Math.Max(qx, qy), 0) - rad);
    if (din < -0.5) continue;
    double outer = Clamp(din + 0.5, 0, 1), inStroke = Clamp(sw2 - din + 0.5, 0, 1), t = Clamp((din - sw2) / gw, 0, 1);
    double a = outer * (FrameStrokeA * inStroke + FrameGlowA * (1 - t) * (1 - t) * (1 - inStroke));
    int ia = (int)Math.Round(a * 255); if (ia <= 0) continue;
    px[y * w + x] = (ia << 24) | ((AccentR * ia / 255) << 16) | ((AccentG * ia / 255) << 8) | (AccentB * ia / 255);
   }
  }
 }
 static void PushFrame(RC r, int w, int h, int a, long now) {
  PT pd = new PT(); pd.x = r.l; pd.y = r.t; SZ sz = new SZ(); sz.cx = w; sz.cy = h; PT ps = new PT();
  BF bf = new BF(); bf.op = 0; bf.fl = 0; bf.a = (byte)Math.Max(0, Math.Min(255, a)); bf.fmt = 1;
  UpdateLayeredWindow(frm, IntPtr.Zero, ref pd, ref sz, mem1, ref ps, 0, ref bf, 2);
  lastAlpha = a; lastPush = now;
 }

 // ---- The pointer: drawn once per display scale with its shadow baked in, then composited at sub-pixel positions. ----
 static GraphicsPath ArrowPath() {
  GraphicsPath gp = new GraphicsPath(); int n = Arrow.Length; PointF[] a = new PointF[n], b = new PointF[n];
  for (int i = 0; i < n; i++) {
   float[] v = Arrow[i], p = Arrow[(i + n - 1) % n], q = Arrow[(i + 1) % n];
   float dp = (float)Math.Sqrt((p[0] - v[0]) * (p[0] - v[0]) + (p[1] - v[1]) * (p[1] - v[1])), dq = (float)Math.Sqrt((q[0] - v[0]) * (q[0] - v[0]) + (q[1] - v[1]) * (q[1] - v[1]));
   float tp = Math.Min(v[2], dp / 2), tq = Math.Min(v[2], dq / 2);
   a[i] = new PointF(v[0] + (p[0] - v[0]) / dp * tp, v[1] + (p[1] - v[1]) / dp * tp);
   b[i] = new PointF(v[0] + (q[0] - v[0]) / dq * tq, v[1] + (q[1] - v[1]) / dq * tq);
  }
  PointF cur0 = b[0];
  for (int i = 1; i <= n; i++) {
   int j = i % n; PointF v = new PointF(Arrow[j][0], Arrow[j][1]);
   gp.AddLine(cur0, a[j]);
   gp.AddBezier(a[j], new PointF(a[j].X + (v.X - a[j].X) * 2f / 3f, a[j].Y + (v.Y - a[j].Y) * 2f / 3f), new PointF(b[j].X + (v.X - b[j].X) * 2f / 3f, b[j].Y + (v.Y - b[j].Y) * 2f / 3f), b[j]);
   cur0 = b[j];
  }
  gp.CloseFigure(); return gp;
 }
 static void BoxBlur(float[] a, int w, int h, int r) {
  float[] t = new float[a.Length];
  for (int pass = 0; pass < 3; pass++) {
   for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) { float sum = 0; for (int i = -r; i <= r; i++) { int xx = x + i; if (xx >= 0 && xx < w) sum += a[y * w + xx]; } t[y * w + x] = sum / (2 * r + 1); }
   for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) { float sum = 0; for (int i = -r; i <= r; i++) { int yy = y + i; if (yy >= 0 && yy < h) sum += t[yy * w + x]; } a[y * w + x] = sum / (2 * r + 1); }
  }
 }
 static Spr MakeSprite(double s) {
  int mg = (int)Math.Round(SprMargin * s), W = mg + (int)Math.Ceiling(SprRight * s), H = mg + (int)Math.Ceiling(SprDown * s);
  Spr sp = new Spr(); sp.W = W; sp.H = H; sp.Tx = mg; sp.Ty = mg;
  using (GraphicsPath gp = ArrowPath()) {
   // The shadow: the silhouette, offset, blurred and faint.
   float[] sh = new float[W * H];
   using (Bitmap tmp = new Bitmap(W, H, PixelFormat.Format32bppArgb)) {
    using (Graphics gt = Graphics.FromImage(tmp)) {
     gt.SmoothingMode = SmoothingMode.AntiAlias; gt.TranslateTransform((float)(mg + ShadowDx * s), (float)(mg + ShadowDy * s)); gt.ScaleTransform((float)s, (float)s);
     gt.FillPath(Brushes.Black, gp);
    }
    BitmapData d = tmp.LockBits(new Rectangle(0, 0, W, H), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    int[] px = new int[W * H]; Marshal.Copy(d.Scan0, px, 0, W * H); tmp.UnlockBits(d);
    for (int i = 0; i < px.Length; i++) sh[i] = ((px[i] >> 24) & 255) / 255f;
   }
   BoxBlur(sh, W, H, Math.Max(1, (int)Math.Round(ShadowBlur * s / 2)));
   int[] outp = new int[W * H];
   for (int i = 0; i < outp.Length; i++) outp[i] = ((int)Math.Round(sh[i] * ShadowA * 255)) << 24;
   sp.Bmp = new Bitmap(W, H, PixelFormat.Format32bppPArgb);
   BitmapData bd = sp.Bmp.LockBits(new Rectangle(0, 0, W, H), ImageLockMode.WriteOnly, PixelFormat.Format32bppPArgb);
   Marshal.Copy(outp, 0, bd.Scan0, W * H); sp.Bmp.UnlockBits(bd);
   using (Graphics g = Graphics.FromImage(sp.Bmp)) {
    g.SmoothingMode = SmoothingMode.AntiAlias; g.CompositingQuality = CompositingQuality.HighQuality; g.PixelOffsetMode = PixelOffsetMode.HighQuality;
    g.TranslateTransform(mg, mg); g.ScaleTransform((float)s, (float)s);
    RectangleF bb = gp.GetBounds();
    using (LinearGradientBrush fill = new LinearGradientBrush(new PointF(0, bb.Top), new PointF(0, bb.Bottom), Color.FromArgb(0x8c, 0xff, 0x8c), Color.FromArgb(0x2f, 0xcb, 0x63))) g.FillPath(fill, gp);
    // A fine highlight down the upper-left edge, fading with depth.
    g.SetClip(gp);
    using (LinearGradientBrush hb = new LinearGradientBrush(new PointF(0, 2f), new PointF(0, 16f), Color.FromArgb(190, 255, 255, 255), Color.FromArgb(0, 255, 255, 255)))
    using (Pen hp = new Pen(hb, 1.0f)) { g.DrawLine(hp, 1.35f, 2.4f, 1.35f, 16f); }
    g.ResetClip();
    using (Pen op = new Pen(Color.FromArgb(230, 0x0b, 0x0f, 0x0c), (float)OutlineW)) { op.LineJoin = LineJoin.Round; g.DrawPath(op, gp); }
   }
  }
  return sp;
 }
 static Spr Sprite(double s) {
  int key = (int)Math.Round(s * 96);
  lock (sprites) {
   Spr sp; if (sprites.TryGetValue(key, out sp)) return sp;
   sp = MakeSprite(key / 96.0); sprites[key] = sp; return sp;
  }
 }
 // The cursor picture: the ripple, then the pointer scaled about its tip, with the tip at (pad + fracX, pad + fracY).
 static void Compose(Graphics g, Spr sp, double s, int pad, double fracX, double fracY, double sc, double rr, double ra, double rw) {
  g.Clear(Color.Transparent);
  g.SmoothingMode = SmoothingMode.AntiAlias; g.CompositingQuality = CompositingQuality.HighQuality; g.InterpolationMode = InterpolationMode.HighQualityBicubic; g.PixelOffsetMode = PixelOffsetMode.Half;
  double tipx = pad + fracX, tipy = pad + fracY;
  if (ra > 0.002 && rr > 0) {
   using (Pen p = new Pen(Color.FromArgb((int)Math.Round(ra * 255), AccentR, AccentG, AccentB), (float)(rw * s))) {
    float rd = (float)(rr * s); g.DrawEllipse(p, (float)tipx - rd, (float)tipy - rd, rd * 2, rd * 2);
   }
  }
  RectangleF dst = new RectangleF((float)(tipx - sp.Tx * sc), (float)(tipy - sp.Ty * sc), (float)(sp.W * sc), (float)(sp.H * sc));
  g.DrawImage(sp.Bmp, dst, new RectangleF(0f, 0f, (float)sp.W, (float)sp.H), GraphicsUnit.Pixel);
 }
 // The cursor window's bitmap is allocated once per size and drawn into in place.
 static void EnsureCursor(double s) {
  int pad = (int)Math.Round(Pad * s);
  if (pad * 2 != curW) {
   if (curG != null) { curG.Dispose(); curG = null; } if (curBmp != null) { curBmp.Dispose(); curBmp = null; }
   if (bmp2 != IntPtr.Zero) { SelectObject(mem2, IntPtr.Zero); DeleteObject(bmp2); DeleteDC(mem2); }
   curW = pad * 2; curPad = pad; bmp2 = Dib(curW, curW, out mem2, out bits2);
   curBmp = new Bitmap(curW, curW, curW * 4, PixelFormat.Format32bppPArgb, bits2); curG = Graphics.FromImage(curBmp); curDirty = true;
  }
  if (curScale != s) { curScale = s; curDirty = true; }
 }
 // Draws and pushes the cursor window only when something about it changed since the last time.
 static void DrawCursor(double s, double fracX, double fracY, double sx, double sy, double sc, int rk, double rr, double ra, double rw, int ca, int cx, int cy, bool force) {
  if (!force && !curDirty && sx == dSx && sy == dSy && sc == dSc && rr == dRr && ra == dRa && ca == dA && rk == dRk) return;
  dSx = sx; dSy = sy; dSc = sc; dRr = rr; dRa = ra; dRw = rw; dA = ca; dRk = rk; curDirty = false;
  Compose(curG, Sprite(s), s, curPad, fracX, fracY, sc, rr, ra, rw);
  PT pd = new PT(); pd.x = cx; pd.y = cy; SZ sz = new SZ(); sz.cx = curW; sz.cy = curW; PT ps = new PT();
  BF bf = new BF(); bf.op = 0; bf.fl = 0; bf.a = (byte)Math.Max(0, Math.Min(255, ca)); bf.fmt = 1;
  UpdateLayeredWindow(cur, IntPtr.Zero, ref pd, ref sz, mem2, ref ps, 0, ref bf, 2);
 }
 static int Steps(IntPtr from, IntPtr to) { IntPtr w = from; for (int i = 0; i < 400 && w != IntPtr.Zero; i++) { if (w == to) return i; w = GetWindow(w, 2); } return -1; }

 // ---- Development aid: one state of the overlay drawn offscreen and saved as a PNG; no window is shown. ----
 static void Backdrop(Graphics g, int kindOf, int x0, int w, int h, double s) {
  if (kindOf == 0) {
   int sq = Math.Max(2, (int)Math.Round(8 * s));
   using (SolidBrush a = new SolidBrush(Color.FromArgb(0x7d, 0x7d, 0x7d))) using (SolidBrush b = new SolidBrush(Color.FromArgb(0x93, 0x93, 0x93)))
    for (int y = 0; y * sq < h; y++) for (int x = 0; x * sq < w; x++) g.FillRectangle(((x + y) & 1) == 0 ? a : b, x0 + x * sq, y * sq, sq, sq);
  } else using (SolidBrush c = new SolidBrush(kindOf == 1 ? Color.FromArgb(0xf3, 0xf4, 0xf6) : Color.FromArgb(0x1b, 0x1e, 0x23))) g.FillRectangle(c, x0, 0, w, h);
 }
 public static string Preview(int dpi, string state, string path) {
  if (dpi < 48 || dpi > 576) throw new Exception("dpi out of range");
  if (state != "rest" && state != "press" && state != "ripple" && state != "frame") throw new Exception("unknown preview state");
  if (string.IsNullOrEmpty(path)) throw new Exception("preview needs a path");
  double s = dpi / 96.0;
  bool frame = state == "frame";
  int pw = (int)Math.Round((frame ? 200 : 80) * s), ph = (int)Math.Round((frame ? 130 : 80) * s);
  using (Bitmap scene = new Bitmap(pw * 3, ph, PixelFormat.Format32bppPArgb)) {
   using (Graphics g = Graphics.FromImage(scene)) {
    for (int i = 0; i < 3; i++) Backdrop(g, i, i * pw, pw, ph, s);
    g.SmoothingMode = SmoothingMode.AntiAlias; g.CompositingQuality = CompositingQuality.HighQuality;
    if (frame) {
     int[] px = new int[pw * ph]; FrameFill(px, pw, ph, s);
     using (Bitmap fb = new Bitmap(pw, ph, PixelFormat.Format32bppPArgb)) {
      BitmapData d = fb.LockBits(new Rectangle(0, 0, pw, ph), ImageLockMode.WriteOnly, PixelFormat.Format32bppPArgb);
      Marshal.Copy(px, 0, d.Scan0, pw * ph); fb.UnlockBits(d);
      for (int i = 0; i < 3; i++) g.DrawImageUnscaled(fb, i * pw, 0);
     }
    } else {
     int pad = (int)Math.Round(Pad * s);
     double sc = 1, rr = 0, ra = 0, rw = 0;
     if (state == "press") { sc = DipScale; Ripple(1, 40, out rr, out ra, out rw); }
     if (state == "ripple") Ripple(1, 200, out rr, out ra, out rw);
     Spr sp = MakeSprite(s);
     using (Bitmap canvas = new Bitmap(pad * 2, pad * 2, PixelFormat.Format32bppPArgb)) {
      using (Graphics gc = Graphics.FromImage(canvas)) Compose(gc, sp, s, pad, 0.4, 0.4, sc, rr, ra, rw);
      for (int i = 0; i < 3; i++) g.DrawImageUnscaled(canvas, i * pw + (int)Math.Round(34 * s) - pad, (int)Math.Round(28 * s) - pad);
     }
     sp.Bmp.Dispose();
    }
   }
   scene.Save(path, ImageFormat.Png);
  }
  return path;
 }

 public static string Info() {
  uint a1, a2; GetWindowDisplayAffinity(frm, out a1); GetWindowDisplayAffinity(cur, out a2);
  return "{\"frame\":\"0x" + Hwnd1.ToString("X") + "\",\"cursor\":\"0x" + Hwnd2.ToString("X") + "\",\"affinity\":[" + a1 + "," + a2 + "],\"ex\":[" + (uint)GetWindowLong(frm, -20) + "," + (uint)GetWindowLong(cur, -20) + "],\"above\":" + (Steps(frm, target) >= 0 ? "true" : "false") + ",\"fvis\":" + (IsWindowVisible(frm) ? 1 : 0) + ",\"cvis\":" + (IsWindowVisible(cur) ? 1 : 0) + ",\"lastAlpha\":" + lastAlpha + ",\"fwh\":\"" + fw + "x" + fh + " last " + lastW + "x" + lastH + " at " + lastX + "," + lastY + "\",\"owned\":" + (ownedBy == target ? "true" : "false") + ",\"refused\":" + Refused + ",\"err\":\"" + Err.Replace("\"", "'") + "\",\"ticks\":" + Ticks + ",\"avgTickUs\":" + (Ticks == 0 ? 0 : TickUs / Ticks) + ",\"maxTickUs\":" + MaxTickUs + ",\"foreground\":\"0x" + ((long)GetForegroundWindow()).ToString("X") + "\"}";
 }
}
'@
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
      'preview' { $r = @{ path = [NzP]::Preview([int]$c.dpi, [string]$c.state, [string]$c.path) } }
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
