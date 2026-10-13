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

You need Node.js 22.13 or newer, and on macOS, Linux or WSL either `curl` or
`wget` to fetch the installer. Namzu's installers check an existing Node and
npm installation; they do not install Node themselves. Get Node from
<https://nodejs.org> (the LTS installer), with `nvm install 22` on macOS, Linux
or WSL, or with `winget install OpenJS.NodeJS.LTS` on Windows; after installing
it on Windows, open a new PowerShell window. A minimal Debian or Ubuntu has
neither `curl` nor `wget` until you run `sudo apt-get install curl`.

## Choose the command for your shell

On macOS, Linux or the Linux side of WSL:

```sh
curl -fsSL https://raw.githubusercontent.com/cogitave/namzu/main/install.sh | sh
namzu --version
namzu doctor
```

Without `curl`, the same installer runs with `wget`:

```sh
wget -qO- https://raw.githubusercontent.com/cogitave/namzu/main/install.sh | sh
```

In native Windows PowerShell, including Windows PowerShell 5.1:

```powershell
irm https://raw.githubusercontent.com/cogitave/namzu/main/install.ps1 | iex
namzu --version
namzu doctor
```

In Windows Command Prompt (`cmd.exe`):

```bat
npm.cmd install --global @namzu/cli
namzu.cmd --version
namzu.cmd doctor
```

`irm` is a PowerShell alias. Command Prompt cannot run it, and a native
Command Prompt does not supply the POSIX `sh` used by `install.sh`.
npm writes a `namzu.ps1` wrapper beside `namzu.cmd`, and PowerShell prefers the
`.ps1`, which the default execution policy refuses ("running scripts is
disabled"). The PowerShell installer and `namzu upgrade` therefore remove that
one file (only when it sits beside `namzu.cmd` and names `@namzu/cli`), so a
bare `namzu` runs `namzu.cmd` under any policy. Use `namzu.cmd` in Command
Prompt, and for `npm` in PowerShell use `npm.cmd`.
WSL and native Windows use separate Node installations, npm prefixes and
Namzu state directories. Installing in one does not install in the other.

## What an installer proves

Both installers require npm to finish successfully and the command to answer
`--version` successfully before reporting completion. Failed npm attempts
retain their diagnostic output when the install cannot be completed. The POSIX
installer retries a failed global installation into a user-owned prefix,
defaulting to `~/.namzu`, and says so in one line instead of printing npm's
error. If that succeeds, it appends one marked block that puts the prefix's bin
directory on `PATH` to the profile of your login shell (`~/.bashrc`, and
`~/.bash_profile` when it exists or on macOS, for bash; `.zshrc` for zsh;
`~/.config/fish/conf.d/namzu.fish` for fish; `~/.profile` otherwise), names the
file it changed, and prints the `export PATH=...` line for the current
terminal, since a piped child shell cannot change its parent's `PATH`. Running
the installer again does not add the block twice. Set `NAMZU_NO_MODIFY_PATH=1`
to leave your profiles alone; the installer then only prints the line. When the
final `--version` check fails, the installer prints what `namzu` said.

If installation succeeds but the command is absent from PATH, the installer
reports the npm prefix or located executable directory. Open a new terminal
after changing PATH. `namzu doctor` checks runtime configuration and available
credentials; installation itself does not sign in to a provider or start the
[scheduler service](scheduler-service.md).

## Reopen the same conversation

From its project directory, use `namzu resume <session-id>` on POSIX systems,
or `namzu resume <session-id>` in PowerShell (`namzu.cmd` in Command Prompt) on native Windows. Conversations belong to
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
