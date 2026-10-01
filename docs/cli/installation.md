---
type: Reference
title: Installing and reopening Namzu
description: Shell-specific installation commands, installer diagnostics and commands for reopening the same conversation.
resource: install.sh
tags: [cli, installation, windows, sessions]
status: stable
generated: { by: human:bahadirarda, at: 2026-10-01T00:00:00Z }
---

# Installing and reopening Namzu

Install Node.js 22.13 or newer first. Namzu's installers check an existing
Node and npm installation; they do not install Node themselves.

## Choose the command for your shell

On macOS, Linux or the Linux side of WSL:

```sh
curl -fsSL https://raw.githubusercontent.com/cogitave/namzu/main/install.sh | sh
namzu --version
namzu doctor
```

In native Windows PowerShell, including Windows PowerShell 5.1:

```powershell
irm https://raw.githubusercontent.com/cogitave/namzu/main/install.ps1 | iex
namzu.cmd --version
namzu.cmd doctor
```

In Windows Command Prompt (`cmd.exe`):

```bat
npm.cmd install --global @namzu/cli
namzu.cmd --version
namzu.cmd doctor
```

`irm` is a PowerShell alias. Command Prompt cannot run it, and a native
Command Prompt does not supply the POSIX `sh` used by `install.sh`.
On Windows, use the explicit `.cmd` commands: PowerShell can resolve bare
`npm` or `namzu` to a `.ps1` wrapper that Restricted execution policy refuses.
Running the `.cmd` wrapper does not require changing that policy.
WSL and native Windows use separate Node installations, npm prefixes and
Namzu state directories. Installing in one does not install in the other.

## What an installer proves

Both installers require npm to finish successfully and the command to answer
`--version` successfully before reporting completion. Failed npm attempts
retain their diagnostic output. The POSIX installer retries a failed global
installation into a user-owned prefix, defaulting to `~/.namzu`. If that
succeeds, copy the printed PATH line into your shell profile; a piped child
shell cannot change its parent's PATH.

If installation succeeds but the command is absent from PATH, the installer
reports the npm prefix or located executable directory. Open a new terminal
after changing PATH. `namzu doctor` checks runtime configuration and available
credentials; installation itself does not sign in to a provider or start the
[scheduler service](scheduler-service.md).

## Reopen the same conversation

From its project directory, use `namzu resume <session-id>` on POSIX systems,
or `namzu.cmd resume <session-id>` on native Windows. Conversations belong to
their project, so a command shown for another directory must include the
directory change and any extra roots that conversation needs.

The TUI prefers the public command only when PATH resolves to the installation
that is running. On Windows, it recognizes npm's `.cmd` wrapper and uses
`namzu.cmd`. A conflicting, missing or unrecognized wrapper retains the
explicit Node executable and entrypoint. Source launches retain their loader
arguments. A fallback containing `dist/bin.js` is an executable handoff to the
same installation, rather than a conversation filename or an npm packaging
error.

Native Windows handoffs target PowerShell explicitly. Directory changes use
`Set-Location -LiteralPath` and resume only after it succeeds, which also works
in PowerShell 5.1. POSIX handoffs use `cd … && …`. Scheduled-run resume commands
carry the job's project directory and additional roots; the Windows form is
also a PowerShell command.
