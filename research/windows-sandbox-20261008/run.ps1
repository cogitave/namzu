# Runs inside Windows Sandbox as the LogonCommand. C:\in is read-only, C:\out is writable.
$ErrorActionPreference = 'Continue'
$out = 'C:\out'
function Receipt($name, $obj) { $obj | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 (Join-Path $out $name) }
Start-Transcript -Path (Join-Path $out 'run-transcript.txt') | Out-Null
$t0 = Get-Date

# 00 environment
$py = Get-Command python.exe -ErrorAction SilentlyContinue
$os = Get-CimInstance Win32_OperatingSystem
Receipt '00-env.json' @{
  check = 'environment'; at = (Get-Date).ToString('o'); user = $env:USERNAME
  os = $os.Caption; build = $os.BuildNumber; freeDiskBytes = (Get-PSDrive C).Free
  memoryMB = [math]::Round($os.TotalVisibleMemorySize / 1024)
  pythonOnPath = if ($py) { $py.Source } else { $null }
  soundDevices = @(Get-CimInstance Win32_SoundDevice | ForEach-Object { $_.Name })
  network = (Test-NetConnection -ComputerName 'huggingface.co' -Port 443 -WarningAction SilentlyContinue).TcpTestSucceeded
}

# 01 silent install of v1
$installer = Get-ChildItem C:\in\v1 -Filter 'Namzu-Setup-*.exe' | Select-Object -First 1
$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath $installer.FullName -ArgumentList '/S' -PassThru -Wait
$sw.Stop()
$dir = Join-Path $env:LOCALAPPDATA 'Programs\Namzu'
$exe = Join-Path $dir 'Namzu.exe'
$startMenu = Get-ChildItem (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs') -Recurse -Filter 'Namzu*.lnk' -ErrorAction SilentlyContinue
$uninstallKeys = @(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like 'Namzu*' } | ForEach-Object { @{ name = $_.DisplayName; version = $_.DisplayVersion; uninstall = $_.UninstallString } })
Receipt '01-install.json' @{
  check = 'silent install'; installer = $installer.Name; installerBytes = $installer.Length
  exitCode = $p.ExitCode; seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
  installDir = $dir; exeExists = (Test-Path $exe)
  fileVersion = if (Test-Path $exe) { (Get-Item $exe).VersionInfo.ProductVersion } else { $null }
  bundledCli = (Test-Path (Join-Path $dir 'resources\cli\dist\bin.js'))
  bundledPython = (Test-Path (Join-Path $dir 'resources\python\python.exe'))
  uninstaller = (Test-Path (Join-Path $dir 'Uninstall Namzu.exe'))
  startMenuShortcuts = @($startMenu | ForEach-Object { $_.FullName })
  registry = $uninstallKeys
  installedBytes = (Get-ChildItem $dir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
  running = @(Get-Process Namzu -ErrorAction SilentlyContinue).Count
}

# The driver runs from a copy of the installed Electron under another name, so the installer can stop and
# replace the real Namzu.exe during the update test without touching the driver.
robocopy $dir C:\drv /E /XD cli python /NFL /NDL /NJH /NJS /NP | Out-Null
Rename-Item C:\drv\Namzu.exe drv-node.exe
# 02.. driven by the installed Electron running the driver as plain Node.
if (Test-Path $exe) {
  $env:ELECTRON_RUN_AS_NODE = '1'
  # Namzu.exe is a GUI-subsystem program: only Start-Process -Wait really waits for it.
  Start-Process -FilePath 'C:\drv\drv-node.exe' -ArgumentList 'C:\in\driver.cjs' -Wait -RedirectStandardOutput (Join-Path $out 'driver-log.txt') -RedirectStandardError (Join-Path $out 'driver-err.txt')
  Remove-Item Env:\ELECTRON_RUN_AS_NODE
}
# 08 silent uninstall keeps the profile
$un = Join-Path $dir 'Uninstall Namzu.exe'
if (Test-Path $un) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $u = Start-Process -FilePath $un -ArgumentList '/currentuser /S' -PassThru -Wait
  Start-Sleep -Seconds 5
  Receipt '08-uninstall.json' @{ check = 'silent uninstall keeps the profile'; exitCode = $u.ExitCode; seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1); exeRemoved = -not (Test-Path $exe); userDataKept = (Test-Path (Join-Path $env:APPDATA 'Namzu')); startMenuRemoved = -not (Test-Path (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Namzu.lnk')) }
}
Receipt 'done.json' @{ finished = (Get-Date).ToString('o'); totalSeconds = [math]::Round(((Get-Date) - $t0).TotalSeconds) }
Stop-Transcript | Out-Null
