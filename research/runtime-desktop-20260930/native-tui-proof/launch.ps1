param(
 [Parameter(Mandatory=$true)][string]$ConsumerRoot,
 [Parameter(Mandatory=$true)][string]$ProofRoot,
 [ValidateSet('startup','resume')][string]$Mode = 'startup'
)
$ErrorActionPreference = 'Stop'
$NodePath = 'C:\Program Files\nodejs\node.exe'
$BinPath = Join-Path $ConsumerRoot 'packages\p0\dist\bin.js'
$AppState = Join-Path $ProofRoot 'h'
$Utf8 = [Text.UTF8Encoding]::new($false)
function Quote-PowerShell([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }
[IO.Directory]::CreateDirectory($ProofRoot) | Out-Null
[IO.Directory]::CreateDirectory($AppState) | Out-Null
foreach ($name in @('preload.mjs','console-control.ps1')) {
 Copy-Item (Join-Path $PSScriptRoot $name) (Join-Path $ProofRoot $name) -Force
}
$env:NAMZU_HOME = $AppState
$env:NAMZU_NATIVE_TUI_PROOF_ROOT = $ProofRoot
$env:NAMZU_NATIVE_TUI_PROOF_RUN = $Mode
$env:NAMZU_PAL_COMPUTER_ENGINE = 'podman'
$env:NAMZU_PAL_PODMAN_BINARY = 'C:\Users\Arda\AppData\Local\Programs\Podman\podman.exe'
$env:NAMZU_PAL_PODMAN_MACHINE = 'podman-machine-default'
$env:NAMZU_PAL_PODMAN_CONNECTION = 'podman-machine-default-root'
$env:NAMZU_PAL_COMPUTER_IMAGE = 'namzu-local-computer:1'
$env:TERM = 'xterm-256color'
$preloadUrl = ([Uri](Join-Path $ProofRoot 'preload.mjs')).AbsoluteUri
if ($Mode -eq 'startup') {
 [IO.File]::WriteAllText((Join-Path $AppState 'preferences.json'), '{"version":3,"providers":[{"id":"ollama","model":"native-fixture"}]}', $Utf8)
 [IO.File]::WriteAllText((Join-Path $AppState 'config.yaml'), "memory:`n  recall: false`nweb:`n  search: off`n", $Utf8)
 $raw = & $NodePath $BinPath pal create 'Native TUI fixture' --purpose LOCAL_NATIVE_TUI_PROFILE_ONLY --model ollama/native-fixture --json
 if ($LASTEXITCODE -ne 0) { throw 'Private fixture Pal creation failed' }
 $pal = $raw | ConvertFrom-Json
 [IO.File]::WriteAllText((Join-Path $ProofRoot 'pal.json'), ($pal | ConvertTo-Json -Depth 8), $Utf8)
 $command = '& ' + (Quote-PowerShell $NodePath) + ' --import ' + (Quote-PowerShell $preloadUrl) + ' ' + (Quote-PowerShell $BinPath) + ' pal chat ' + (Quote-PowerShell $pal.id)
} else {
 $out = [IO.File]::ReadAllText((Join-Path $ProofRoot 'startup-stdout.txt'))
 $match = [regex]::Match($out, 'To resume this conversation, run in PowerShell: ([^\r\n]+)')
 if (!$match.Success) { throw 'Exit startup with /exit before resuming' }
 $command = $match.Groups[1].Value
 [IO.File]::WriteAllText((Join-Path $ProofRoot 'resume-command.txt'), $command, $Utf8)
 # Test instrumentation is inherited, leaving the printed command unchanged.
 $env:NODE_OPTIONS = '--import=' + $preloadUrl
}
$runner = Join-Path $ProofRoot ($Mode + '-console.ps1')
[IO.File]::WriteAllText($runner, "$command`n[IO.File]::WriteAllText(" + (Quote-PowerShell (Join-Path $ProofRoot ($Mode + '-shell-exit.txt'))) + ", [string]`$LASTEXITCODE)`nexit `$LASTEXITCODE`n", $Utf8)
$shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$child = Start-Process -FilePath $shell -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + $runner + '"') -WorkingDirectory $ProofRoot -PassThru
[IO.File]::WriteAllText((Join-Path $ProofRoot ($Mode + '-owned-shell-pid.txt')), [string]$child.Id, $Utf8)
Write-Output "Owned console launched: $($child.Id). Read $Mode-console-ready.json for the actual Node console PID."
