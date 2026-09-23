/**
 * The PowerShell half of the `windows-cdp` engine, run by Windows PowerShell
 * 5.1 (every Windows 10 and 11 has it) through WSL interop. It needs nothing
 * installed on Windows beyond the browser.
 *
 * It reads its parameters from `__NAMZU_BRIDGE_PARAMS__` (base64 JSON, so no
 * quoting reaches PowerShell's parser), then:
 *
 * 1. attaches to a browser already running on the profile, if the profile's
 *    `DevToolsActivePort` names a port that answers;
 * 2. otherwise deletes a stale `DevToolsActivePort`, starts the browser with
 *    `--user-data-dir=<profile> --remote-debugging-port=0` (the browser picks a
 *    free port on `127.0.0.1` and writes it to that file), and polls the file;
 * 3. announces itself with one `@namzu {"type":"ready",…}` line;
 * 4. relays CDP: every stdin line starting `{` is one message sent to the
 *    browser; every message from the browser, assembled from however many
 *    WebSocket frames it came in, is one stdout line. CDP's JSON never holds
 *    a raw newline, so a line is a message;
 * 5. exits when stdin closes or the browser goes away. If it started the
 *    browser and was told to close on exit (and no `@namzu keep` line has
 *    arrived since), it closes the browser first: `Browser.close` over CDP,
 *    then, after ten seconds, the process it started, by id. Nothing else is
 *    ever stopped.
 *
 * Every line it writes is either a CDP message (`{…}`) or a control line
 * (`@namzu {…}`). PowerShell's own errors go to stderr.
 */
export const WINDOWS_BRIDGE_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = New-Object System.Text.UTF8Encoding $false
$P = $utf8.GetString([Convert]::FromBase64String('__NAMZU_BRIDGE_PARAMS__')) | ConvertFrom-Json
$out = New-Object System.IO.BufferedStream ([Console]::OpenStandardOutput()), 1048576
$in = New-Object System.IO.StreamReader ([Console]::OpenStandardInput(65536)), $utf8, $false, 1048576
$newline = [byte[]](10)
function Emit([byte[]]$bytes, [int]$count) { $out.Write($bytes, 0, $count); $out.Write($newline, 0, 1); $out.Flush() }
function Say($obj) { $b = $utf8.GetBytes('@namzu ' + ($obj | ConvertTo-Json -Compress)); Emit $b $b.Length }
function Fail([string]$code, [string]$message) { Say @{ type = 'error'; code = $code; message = $message }; exit 1 }

$dir = [string]$P.userDataDir
if (-not $dir) {
  if (-not $env:LOCALAPPDATA) { Fail 'no-localappdata' 'LOCALAPPDATA is not set on the Windows side.' }
  $dir = Join-Path $env:LOCALAPPDATA ('namzu\browser\profiles\' + [string]$P.profile)
}
$portFile = Join-Path $dir 'DevToolsActivePort'

function Read-Endpoint {
  if (-not (Test-Path -LiteralPath $portFile)) { return $null }
  try { $lines = [System.IO.File]::ReadAllLines($portFile) } catch { return $null }
  if ($lines.Count -lt 2) { return $null }
  $port = 0
  if (-not [int]::TryParse($lines[0].Trim(), [ref]$port) -or $port -le 0 -or $port -gt 65535) { return $null }
  $path = $lines[1].Trim()
  if ($path -notmatch '^/devtools/browser/[A-Za-z0-9-]+$') { return $null }
  return @{ port = $port; path = $path }
}

function Open-Socket($ep, [int]$ms) {
  $s = New-Object System.Net.WebSockets.ClientWebSocket
  $cts = New-Object System.Threading.CancellationTokenSource $ms
  try {
    $s.ConnectAsync([Uri]('ws://127.0.0.1:' + $ep.port + $ep.path), $cts.Token).Wait()
    return $s
  } catch {
    $s.Dispose()
    return $null
  }
}

$ws = $null
$proc = $null
$ep = Read-Endpoint
if ($ep) { $ws = Open-Socket $ep 2000 }
if (-not $ws) {
  if ($P.attachOnly) { Fail 'not-running' ('No browser with remote debugging is running on ' + $dir + '.') }
  if (Test-Path -LiteralPath $portFile) { Remove-Item -LiteralPath $portFile -Force -ErrorAction SilentlyContinue }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $argv = @('"--user-data-dir=' + $dir + '"', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check')
  if ($P.headless) { $argv += '--headless=new'; $argv += '--window-size=1280,800' }
  $argv += 'about:blank'
  try { $proc = Start-Process -FilePath ([string]$P.executable) -ArgumentList $argv -PassThru }
  catch { Fail 'launch-failed' ('Could not start ' + $P.executable + ': ' + $_.Exception.Message) }
  $null = $proc.Handle
  $deadline = [DateTime]::UtcNow.AddMilliseconds([int]$P.launchTimeoutMs)
  while (-not $ws) {
    $ep = Read-Endpoint
    if ($ep) { $ws = Open-Socket $ep 2000 }
    if ($ws) { break }
    if ($proc.HasExited) {
      Fail 'browser-exited' ('The browser exited (code ' + $proc.ExitCode + ') before it opened a debugging port. The profile is probably open in a window started without remote debugging; close that window and try again.')
    }
    if ([DateTime]::UtcNow -gt $deadline) {
      try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { }
      Fail 'launch-timeout' ('The browser did not open a debugging port within ' + $P.launchTimeoutMs + ' ms.')
    }
    Start-Sleep -Milliseconds 50
  }
}

$launched = $null -ne $proc
$procId = 0
if ($launched) { $procId = $proc.Id }
Say @{ type = 'ready'; userDataDir = $dir; port = $ep.port; path = $ep.path; launched = $launched; pid = $procId; localAppData = [string]$env:LOCALAPPDATA }

$closeOnExit = [bool]$P.closeOnExit
$none = [System.Threading.CancellationToken]::None
$buf = New-Object byte[] 1048576
$seg = New-Object 'System.ArraySegment[byte]' -ArgumentList (,$buf)
$msg = New-Object System.IO.MemoryStream
$text = [System.Net.WebSockets.WebSocketMessageType]::Text
$readTask = $in.ReadLineAsync()
$recvTask = $ws.ReceiveAsync($seg, $none)
$why = 'stdin'
try {
  while ($true) {
    [void][System.Threading.Tasks.Task]::WaitAny([System.Threading.Tasks.Task[]]@($readTask, $recvTask))
    if ($recvTask.IsCompleted) {
      if ($recvTask.IsFaulted -or $recvTask.IsCanceled) { $why = 'socket'; break }
      $r = $recvTask.Result
      if ($r.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { $why = 'browser'; break }
      $msg.Write($buf, 0, $r.Count)
      if ($r.EndOfMessage) {
        Emit $msg.GetBuffer() ([int]$msg.Length)
        $msg.SetLength(0)
      }
      $recvTask = $ws.ReceiveAsync($seg, $none)
    }
    if ($readTask.IsCompleted) {
      if ($readTask.IsFaulted) { break }
      $line = $readTask.Result
      if ($null -eq $line) { break }
      if ($line.StartsWith('{')) {
        $bytes = $utf8.GetBytes($line)
        $ws.SendAsync((New-Object 'System.ArraySegment[byte]' -ArgumentList (,$bytes)), $text, $true, $none).Wait()
      } elseif ($line -eq '@namzu keep') {
        $closeOnExit = $false
      } elseif ($line -eq '@namzu close') {
        $closeOnExit = $true
      }
      $readTask = $in.ReadLineAsync()
    }
  }
} catch {
  $why = 'error: ' + $_.Exception.Message
}

if ($launched -and $closeOnExit -and -not $proc.HasExited) {
  try {
    if ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
      $bye = $utf8.GetBytes('{"id":2147483000,"method":"Browser.close"}')
      $ws.SendAsync((New-Object 'System.ArraySegment[byte]' -ArgumentList (,$bye)), $text, $true, $none).Wait(2000) | Out-Null
    }
  } catch { }
  if (-not $proc.WaitForExit(10000)) {
    try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { }
  }
}
try { $ws.Abort() } catch { }
try { Say @{ type = 'exit'; reason = $why } } catch { }
exit 0
`
