# Answers the native "Allow folder access?" dialog. Prints what it did; exit 0 when a key was sent.
# The dialog is a TaskDialog whose command link is not exposed to UI Automation as a button, so the
# window is found by title with user32, brought to the front, and the link reached with Shift+Tab
# (focus starts on Cancel) and pressed with Enter.
param([string]$Title = 'Allow folder access?', [int]$TimeoutSeconds = 20)
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Text;
public class W { 
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public static string Titles() { var sb = new StringBuilder(); EnumWindows((h, l) => { if (IsWindowVisible(h)) { var t = new StringBuilder(256); GetWindowText(h, t, 256); if (t.Length > 0) sb.Append(t.ToString() + " | "); } return true; }, IntPtr.Zero); return sb.ToString(); }
}
'@
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
  $h = [W]::FindWindow([NullString]::Value, $Title)
  if ($h -ne [IntPtr]::Zero) {
    [W]::ShowWindow($h, 9) | Out-Null
    [W]::SetForegroundWindow($h) | Out-Null
    Start-Sleep -Milliseconds 500
    [System.Windows.Forms.SendKeys]::SendWait('+{TAB}')
    Start-Sleep -Milliseconds 300
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    'keys sent'; exit 0
  }
  Start-Sleep -Milliseconds 300
}
'dialog not found; windows: ' + [W]::Titles(); exit 1
