param([int]$OwnedPid, [string]$InputPath, [string]$ResultPath)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class OwnedConsole {
 [StructLayout(LayoutKind.Explicit, CharSet=CharSet.Unicode, Size=20)]
 public struct InputRecord {
  [FieldOffset(0)] public ushort EventType;
  [FieldOffset(4), MarshalAs(UnmanagedType.Bool)] public bool KeyDown;
  [FieldOffset(8)] public ushort RepeatCount;
  [FieldOffset(10)] public ushort VirtualKey;
  [FieldOffset(12)] public ushort ScanCode;
  [FieldOffset(14)] public char Character;
  [FieldOffset(16)] public uint ControlState;
 }
 [StructLayout(LayoutKind.Sequential)] public struct Coord { public short X; public short Y; }
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public short Left; public short Top; public short Right; public short Bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct Info { public Coord Size; public Coord Cursor; public ushort Attributes; public Rect Window; public Coord MaxSize; }
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
 [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern IntPtr CreateFile(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool WriteConsoleInputW(IntPtr handle,InputRecord[] records,uint count,out uint written);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetConsoleScreenBufferInfo(IntPtr handle,out Info info);
 [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool ReadConsoleOutputCharacterW(IntPtr handle,StringBuilder text,uint length,Coord start,out uint read);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
 public static string Control(int pid, string input) {
  FreeConsole();
  if (!AttachConsole((uint)pid)) throw new Exception("AttachConsole: " + Marshal.GetLastWin32Error());
  IntPtr h=CreateFile("CONIN$",0xC0000000,3,IntPtr.Zero,3,0,IntPtr.Zero);
  if(h.ToInt64()==-1) throw new Exception("CONIN$: " + Marshal.GetLastWin32Error());
  try {
   var rows = new InputRecord[input.Length*2];
   for(int i=0;i<input.Length;i++) {
    ushort key=input[i]=='\r'?(ushort)13:(ushort)0;
    rows[i*2]=new InputRecord { EventType=1,KeyDown=true,RepeatCount=1,VirtualKey=key,Character=input[i] };
    rows[i*2+1]=new InputRecord { EventType=1,KeyDown=false,RepeatCount=1,VirtualKey=key,Character=input[i] };
   }
   uint written;
   if(rows.Length>0 && !WriteConsoleInputW(h,rows,(uint)rows.Length,out written)) throw new Exception("WriteConsoleInput: " + Marshal.GetLastWin32Error());
  } finally { CloseHandle(h); }
  IntPtr output=CreateFile("CONOUT$",0x80000000,3,IntPtr.Zero,3,0,IntPtr.Zero);
  try {
   Info info;
   if(!GetConsoleScreenBufferInfo(output,out info)) throw new Exception("ScreenInfo: " + Marshal.GetLastWin32Error());
   var text=new StringBuilder(info.Size.X*info.Size.Y);
   uint read;
   if(!ReadConsoleOutputCharacterW(output,text,(uint)text.Capacity,new Coord {X=0,Y=0},out read)) throw new Exception("ReadConsole: " + Marshal.GetLastWin32Error());
   var lines=new StringBuilder();
   for(int start=0;start<text.Length;start+=info.Size.X) lines.AppendLine(text.ToString(start,Math.Min(info.Size.X,text.Length-start)).TrimEnd());
   return lines.ToString();
  } finally { CloseHandle(output); FreeConsole(); }
 }
}
'@
try {
 $text = if ($InputPath) { [IO.File]::ReadAllText($InputPath) } else { '' }
 $screen = [OwnedConsole]::Control($OwnedPid, $text)
 [IO.File]::WriteAllText($ResultPath, ($screen | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
} catch {
 [IO.File]::WriteAllText($ResultPath, ($_ | Out-String), [Text.UTF8Encoding]::new($false))
 exit 1
}
