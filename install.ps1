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
# Verified by parsing this file with `[Parser]::ParseFile` under 5.1 itself
# (0 errors), and that check was confirmed able to fail — an unclosed block in
# a copy is reported. There is deliberately NO CI gate for it: CI runs Linux,
# where the only available parser is PowerShell 7, and 7 is a superset that
# accepts the very constructs 5.1 would reject. A gate there would pass on the
# syntax this comment exists to forbid, which is worse than no gate — it would
# read as coverage. `install.sh` is gated because `sh -n` on Linux does test
# what ships; this one has to be checked on Windows, by hand, when it changes.

$ErrorActionPreference = 'Stop'

$NamzuPkg = '@namzu/cli'
$NamzuMinNode = 20
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
  namzu runs on Node 20 or newer. Install it, then run this again:
    winget install OpenJS.NodeJS.LTS
'@
}

$nodeVersion = (& node -v)
# `v20.11.1` -> 20. A non-numeric answer means something other than Node is
# responding to that name, which is worth saying rather than comparing against.
if ($nodeVersion -notmatch '^v(\d+)\.') {
    Fail "could not read a version from 'node -v'. Got: $nodeVersion"
}
$nodeMajor = [int]$Matches[1]

if ($nodeMajor -lt $NamzuMinNode) {
    Fail "Node $nodeVersion is too old. namzu needs Node $NamzuMinNode or newer."
}

if (-not (Test-Have 'npm')) {
    Fail @'
found Node but no npm on PATH.
  npm ships with Node; a PATH with one and not the other is usually a partial
  install. Reinstall Node, then run this again.
'@
}

Write-Step "Node $nodeVersion, installing $NamzuPkg@$NamzuVersion"

# ---------------------------------------------------------------- install

# `2>&1 | Out-Null` rather than a redirect: npm writes progress to stderr even
# on success, and in PowerShell 5.1 a native command's stderr becomes an
# ErrorRecord that trips $ErrorActionPreference = 'Stop'.
& npm install --global --no-fund --no-audit "$NamzuPkg@$NamzuVersion" 2>&1 | Out-Null
$installExit = $LASTEXITCODE

if ($installExit -ne 0) {
    Fail @"
npm install failed (exit $installExit).
  Re-run it by hand to see why:
    npm install --global $NamzuPkg@$NamzuVersion
"@
}

# ---------------------------------------------------------------- verify

# A fresh global install lands in a directory this process may not have had on
# PATH when it started, so refresh from the registry before deciding it is
# missing. Otherwise a perfectly good install reports as broken.
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
            [Environment]::GetEnvironmentVariable('Path', 'User')

if (-not (Test-Have 'namzu')) {
    $prefix = (& npm prefix --global)
    Fail @"
installed, but 'namzu' is not on PATH.
  npm put it in: $prefix
  Add that directory to your PATH, or open a new terminal and try again.
"@
}

$installed = (& namzu --version)
if ($LASTEXITCODE -ne 0 -or -not $installed) {
    Fail @'
'namzu' is on PATH but did not answer --version.
  Run 'namzu doctor' to see what it says about itself.
'@
}

Write-Step "$installed installed."
Write-Host ''
Write-Host "Next: run 'namzu doctor' to check credentials and sandboxing,"
Write-Host "or just 'namzu' to open the terminal agent."
