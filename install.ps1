# Install the namzu terminal agent on Windows.
#
#   irm https://raw.githubusercontent.com/cogitave/namzu/main/install.ps1 | iex
#
# The counterpart to install.sh, and deliberately the same shape: find a Node
# runtime, check it is new enough, install, then prove the binary answers before
# claiming anything. An installer that stops at "the package manager exited 0"
# reports success for a binary that is not on PATH.
#
# Windows PowerShell 5.1 compatible on purpose — it is what ships with the OS,
# so it is what someone with nothing installed has. No ternaries, no `??`, no
# `&&`; those are PowerShell 7 and would fail on the one machine this has to
# work on.
#
# On Windows or WSL, `node --test scripts/__tests__/install-powershell.test.mjs`
# runs this source in Windows PowerShell 5.1 under Restricted policy with mocked
# node, npm and namzu commands. CI runs Linux without 5.1, so run that test on
# Windows or WSL whenever this file changes. A PowerShell 7 parse on Linux
# would not catch 5.1-only syntax failures.

$ErrorActionPreference = 'Stop'

$NamzuPkg = '@namzu/cli'
$NamzuMinNode = 22
$NamzuMinNodeMinor = 13
# Pin with: $env:NAMZU_VERSION = '2.1.1'; irm ... | iex
$NamzuVersion = if ($env:NAMZU_VERSION) { $env:NAMZU_VERSION } else { 'latest' }

function Write-Step($msg) { Write-Host "namzu: $msg" }

function Fail($msg) {
    Write-Host ''
    Write-Host "install: $msg" -ForegroundColor Red
    exit 1
}

function Test-Have($name) {
    $null -ne (Get-Command $name -ErrorAction SilentlyContinue)
}

# ---------------------------------------------------------------- node

if (-not (Test-Have 'node')) {
    Fail @'
no Node runtime on PATH.
  namzu runs on Node 22.13 or newer. Install it, then run this again:
    winget install OpenJS.NodeJS.LTS
'@
}

$nodeVersion = (& node -v)
# `v22.13.0` -> 22 and 13. A non-numeric answer means something other than Node is
# responding to that name, which is worth saying rather than comparing against.
if ($nodeVersion -notmatch '^v(\d+)\.(\d+)\.') {
    Fail "could not read a version from 'node -v'. Got: $nodeVersion"
}
$nodeMajor = [int]$Matches[1]
$nodeMinor = [int]$Matches[2]

if ($nodeMajor -lt $NamzuMinNode -or
    ($nodeMajor -eq $NamzuMinNode -and $nodeMinor -lt $NamzuMinNodeMinor)) {
    Fail "Node $nodeVersion is too old. namzu needs Node $NamzuMinNode.$NamzuMinNodeMinor or newer."
}

if (-not (Test-Have 'npm.cmd')) {
    Fail @'
found Node but no npm on PATH.
  npm ships with Node; a PATH with one and not the other is usually a partial
  install. Reinstall Node, then run this again.
'@
}

Write-Step "Node $nodeVersion, installing $NamzuPkg@$NamzuVersion"

# ---------------------------------------------------------------- install

# Use the .cmd shim explicitly. Under Restricted execution policy, PowerShell
# resolves bare `npm` to npm.ps1 and refuses to run it even when npm.cmd works.
# PowerShell 5.1 turns native stderr into ErrorRecords. Even `2>&1`
# can throw under Stop when npm succeeds but prints a warning. Let that one
# native call continue, capture its exit code, and restore the script policy.
$previousErrorActionPreference = $ErrorActionPreference
try {
    $ErrorActionPreference = 'Continue'
    $installOutput = @(& npm.cmd install --global --no-fund --no-audit "$NamzuPkg@$NamzuVersion" 2>&1)
    $installExit = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousErrorActionPreference
}

if ($installExit -ne 0) {
    # Render captured ErrorRecords as text so the original npm reason remains
    # visible without turning successful native stderr into a terminating error.
    foreach ($line in $installOutput) { Write-Host "$line" }
    Fail @"
npm install failed (exit $installExit).
  Re-run it by hand to see why:
    npm.cmd install --global $NamzuPkg@$NamzuVersion
"@
}

# ---------------------------------------------------------------- verify

# A fresh global install may land on the persisted machine or user PATH. Add
# those entries without dropping a process-local Node/npm prefix.
$env:Path += ';' + [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
             [Environment]::GetEnvironmentVariable('Path', 'User')

if (-not (Test-Have 'namzu.cmd')) {
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $prefix = (& npm.cmd prefix --global 2>$null)
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    Fail @"
installed, but 'namzu' is not on PATH.
  npm put it in: $prefix
  Add that directory to your PATH, or open a new terminal and try again.
"@
}

$previousErrorActionPreference = $ErrorActionPreference
try {
    $ErrorActionPreference = 'Continue'
    $installed = (& namzu.cmd --version 2>$null)
    $verifyExit = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousErrorActionPreference
}
if ($verifyExit -ne 0 -or -not $installed) {
    Fail @'
'namzu' is on PATH but did not answer --version.
  Run 'namzu.cmd doctor' to see what it says about itself.
'@
}

Write-Step "$installed installed."
Write-Host ''
Write-Host "Next: run 'namzu.cmd doctor' to check credentials and sandboxing,"
Write-Host "or just 'namzu.cmd' to open the terminal agent."
