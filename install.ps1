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

# The whole script runs in its own scope, so that under `irm | iex` none of its
# variables, functions or its error preference stay behind in the person's session.
& {
    $ErrorActionPreference = 'Stop'

    $NamzuPkg = '@namzu/cli'
    $NamzuMinNode = 22
    $NamzuMinNodeMinor = 13
    # Pin with: $env:NAMZU_VERSION = '2.1.1'; irm ... | iex
    $NamzuVersion = if ($env:NAMZU_VERSION) { $env:NAMZU_VERSION } else { 'latest' }

    function Write-Step($msg) { Write-Host "namzu: $msg" }

    # Under `irm | iex` this script runs inside the window the person typed it into,
    # and `exit` would close that window, taking the reason with it. So a failure
    # stops the script, and only a caller that reads the exit code gets one: a file
    # run, a redirected stdin (CI, a test, a parent process) or -NonInteractive.
    $NamzuStopped = 'namzu-install-stopped'

    function Test-ExitCodeIsRead {
        if ($PSCommandPath) { return $true }
        if ([Console]::IsInputRedirected) { return $true }
        foreach ($arg in [Environment]::GetCommandLineArgs()) {
            if ($arg -match '^[-/]noni') { return $true }
        }
        return $false
    }

    function Fail($msg) {
        Write-Host ''
        Write-Host "install: $msg" -ForegroundColor Red
        throw $NamzuStopped
    }

    function Test-Have($name) {
        $null -ne (Get-Command $name -ErrorAction SilentlyContinue)
    }

    try {
        # ---------------------------------------------------------------- node

        if (-not (Test-Have 'node')) {
            Fail @'
no Node runtime on PATH.
  namzu runs on Node 22.13 or newer. Get it from https://nodejs.org (the LTS
  installer), or with winget:
    winget install OpenJS.NodeJS.LTS
  Then open a NEW PowerShell window (the one you are in will not see the new
  Node) and run this again.
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
            Fail @"
Node $nodeVersion is too old. namzu needs Node $NamzuMinNode.$NamzuMinNodeMinor or newer.
  Get a current one from https://nodejs.org (the LTS installer), or with winget:
    winget install OpenJS.NodeJS.LTS
  Then open a NEW PowerShell window and run this again.
"@
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
            # stderr is kept: when the check fails it is the only reason.
            $versionOutput = @(& namzu.cmd --version 2>&1)
            $verifyExit = $LASTEXITCODE
            $installed = ($versionOutput | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] } | Out-String).Trim()
            $versionReason = ($versionOutput | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } | ForEach-Object { "$_" }) -join "`n"
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        if ($verifyExit -ne 0 -or -not $installed) {
            $said = ''
            if ($versionReason) { $said = "  It said:`n$versionReason`n" }
            Fail @"
'namzu' is on PATH but did not answer --version.
${said}  Run 'namzu.cmd doctor' to see what it says about itself.
"@
        }

        # npm also writes namzu.ps1 next to namzu.cmd. In PowerShell a bare `namzu`
        # resolves to the .ps1 first, and under the default execution policy
        # ("running scripts is disabled") it refuses to run, so a fresh install would
        # fail on the first command the README gives. Removing our own .ps1 shim makes
        # `namzu` resolve to namzu.cmd under any policy. Only that one file, and only
        # when it sits beside namzu.cmd and names @namzu/cli: never someone else's.
        try {
            $previousErrorActionPreference = $ErrorActionPreference
            try {
                $ErrorActionPreference = 'Continue'
                $npmPrefix = (& npm.cmd prefix --global 2>$null | Select-Object -First 1)
            } finally {
                $ErrorActionPreference = $previousErrorActionPreference
            }
            if ($npmPrefix) {
                $shim = Join-Path "$npmPrefix" 'namzu.ps1'
                $cmdShim = Join-Path "$npmPrefix" 'namzu.cmd'
                if ((Test-Path -LiteralPath $shim) -and (Test-Path -LiteralPath $cmdShim) -and
                    ((Get-Content -LiteralPath $shim -Raw) -match '@namzu[/\\]cli')) {
                    Remove-Item -LiteralPath $shim -Force
                }
            }
        } catch {
            # Best effort: namzu.cmd still works, and the install itself succeeded.
        }

        Write-Step "$installed installed."
        Write-Host ''
        Write-Host "Next: run 'namzu doctor' to check credentials and sandboxing,"
        Write-Host "or just 'namzu' to open the terminal agent."
        # `npm.cmd prefix | Select-Object -First 1` stops npm early and leaves -1 behind.
        $global:LASTEXITCODE = 0
    } catch {
        if ("$($_.Exception.Message)" -ne $NamzuStopped) { throw }
        if (Test-ExitCodeIsRead) { exit 1 }
        $global:LASTEXITCODE = 1
    }
}
