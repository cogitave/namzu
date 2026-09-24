---
type: Reference
title: The scheduler service
description: How `namzu schedule install` runs the scheduler under systemd, launchd, Windows Task Scheduler and WSL — the files it writes, the single owner and its standby, upgrades, status and exit codes, notifications, uninstalling, and manual checks per platform.
resource: packages/cli/src/schedule/service/
tags: [cli, schedule, service, systemd, launchd, windows, wsl]
status: stable
generated: { by: process:claude-code, at: 2026-09-23T00:00:00Z }
---

# The scheduler service

[Scheduled tasks](scheduled-tasks.md) are run by one scheduler process per
`NAMZU_HOME`: `namzu schedule daemon`. `namzu schedule install` has your
platform's service manager keep it running. The service always starts

```text
"<absolute node>" "<absolute namzu CLI>" schedule daemon --home "<NAMZU_HOME>"
```

with both paths resolved at install: no shell, no PATH lookup, no profile.
`install` is safe to run again (after moving node, or to repair it).

```sh
namzu schedule install [--platform auto|systemd-user|launchd|windows-task|wsl-windows-task] \
                       [--name <service>] [--at-boot] [--dry-run]
namzu schedule status [--json]
namzu schedule stop | start
namzu schedule uninstall [--keep-data | --purge-data] [--wait 10m | --interrupt-runs]
```

`--dry-run` prints the unit, property list or task XML it would write. The
service is named `namzu-scheduler` for `~/.namzu`, else
`namzu-scheduler-<8 hex of the home's hash>`; `--name` overrides it.

`install` refuses a CLI running from the npx cache (it is not kept) and a node
that is not an absolute path.

## Per platform

| Platform (`auto` picks) | Supervisor | Starts | Keeps it alive |
|---|---|---|---|
| Linux with a systemd user manager | `~/.config/systemd/user/<name>.service` | at login; at boot with `--at-boot` (linger) | `Restart=always` |
| macOS | `~/Library/LaunchAgents/com.namzu.scheduler[…].plist` | at login | `KeepAlive=true` |
| Windows | Task Scheduler `\namzu\<name>` | at logon | a trigger repeating every 5 minutes |
| WSL | Task Scheduler `\namzu\<name>-wsl-<distro>`, through `wsl.exe` | at Windows logon | a trigger repeating every 5 minutes |

### Linux: systemd

```ini
[Unit]
Description=namzu scheduler (NAMZU_HOME=/home/you/.namzu)
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart="/usr/bin/node" "/usr/lib/node_modules/@namzu/cli/dist/bin.js" "schedule" "daemon" "--home" "/home/you/.namzu"
Environment="NAMZU_HOME=/home/you/.namzu"
Restart=always
RestartSec=10
SuccessExitStatus=80
RestartPreventExitStatus=80
KillMode=process
TimeoutStopSec=20

[Install]
WantedBy=default.target
```

Values are quoted by systemd's rules (`%` and `$` doubled). `KillMode=process`
leaves runs in progress alone when the daemon stops or restarts: they finish,
record their result, and the next daemon adopts them. `--at-boot` runs
`loginctl enable-linger`; `uninstall` turns linger off only if install turned
it on.

### macOS: launchd

A LaunchAgent with `RunAtLoad`, `KeepAlive=true`, `ThrottleInterval=10`,
`ProcessType=Background`, `AbandonProcessGroup=true` (the same intent as
`KillMode=process`) and `LimitLoadToSessionType=Aqua` (the graphical session,
where notifications can be shown). The daemon's own output goes to
`NAMZU_HOME/schedule/daemon/launchd.{out,err}.log`. Installed with `launchctl
bootstrap gui/<uid>`, falling back to `user/<uid>`.

A LaunchAgent reading `~/Documents`, `~/Desktop` or `~/Downloads` meets macOS's
privacy protection: a prompt nobody sees, or a refusal. `add` warns for such a
folder, and a run that cannot list its folder stops with `blocked-config`
naming the cause. Grant the scheduler's node Files and Folders access, or keep
scheduled projects elsewhere.

### Windows and WSL: Task Scheduler

The task has two triggers: at your logon, and a time trigger repeating every
five minutes forever, with `MultipleInstancesPolicy=IgnoreNew` (a repetition
while the daemon runs does nothing) and no time limit. Task Scheduler's
restart-on-failure reacts to a task that fails to launch, not to a non-zero
exit, so the repetition is what brings the daemon back after a crash or `wsl
--shutdown` — within five minutes. The task names your account (`DOMAIN\user`,
from `whoami.exe`) on its principal and its logon trigger, which is what lets it
register without administrator rights. It runs only while you are logged on:
WSL does not start from a task that runs without a logon session. The task XML
is written UTF-16LE with a byte-order mark and deleted after registration.

The action runs `conhost.exe --headless`, so no console window appears.

Under **WSL** the daemon runs inside the distro:

```text
C:\Windows\System32\conhost.exe --headless C:\Windows\System32\wsl.exe -d <distro> -u <user>
  --cd / --exec /usr/bin/env NAMZU_HOME=<home> <node> <cli> schedule daemon --home <home>
```

The `wsl.exe` process the task holds both starts the distro after a reboot and
keeps WSL from shutting it down while idle, which a systemd unit inside the
distro cannot do — hence Task Scheduler even when the distro runs systemd.
`--platform systemd-user` stays available inside WSL; it has no Windows
notifications (below).

`wsl.exe` re-reads its command line on the Linux side, so a node, CLI or home
path with anything but letters, digits and `. _ / @ + -` is refused rather than
escaped. `install` checks that interop answers (a Windows program starts and
exits 0) and refuses with the reason if it does not (`[interop] enabled=false`
in `/etc/wsl.conf`). The Windows programs are found at their fixed locations
under the drive mount root (`[automount] root` in `/etc/wsl.conf`, `/mnt/` by
default), never through PATH, and recorded in the manifest. They are started in
`C:` under that root, as is the PowerShell that shows a Windows notification. Runs get a PATH without the
Windows `/mnt/*` entries: a failed lookup through them costs seconds.

A job with a [browser grant](scheduled-tasks.md#browser-access) drives the
Windows Chrome or Edge from inside WSL, as the TUI does, through
`powershell.exe` at its fixed path. A service has no `WSL_INTEROP`, under
Task Scheduler's `wsl.exe` or a systemd user unit alike; the run finds an
interop socket under `/run/WSL` and hands it to `powershell.exe` only, as the
[notifications](#notifications) do. The browser starts without a window
(`--headless=new`) unless the job has `--browser-headed`, and the profile's
user data stays on the Windows side under `%LOCALAPPDATA%\namzu\browser\profiles\<name>`.
A run whose interop, `powershell.exe` or browser is missing is `blocked-config`
before the model is called; it never falls back to a Chromium inside WSL,
which would start signed out.

## One owner, and its standby

Ownership of a home is a fenced lease in `schedule/daemon/`: `lease.<fence>.json`
files published with `link`, the highest fence owning, renewed every 30 seconds
and expiring after 90. A second daemon — a supervisor starting one while
another runs, or you running `namzu schedule daemon` by hand — **does not
exit**: it logs `scheduler on standby` and takes over when the owner's lease
expires. The owner checks its fence is still the highest before starting any
run, and one that finds itself fenced out stops dispatching at once. Independently
of the lease, every scheduled time is claimed with a file only one process can
create, so a run never starts twice. `schedule daemon --once-or-exit` exits 75
instead of waiting.

`namzu schedule stop` and `uninstall` also leave `schedule/daemon/stop.json`,
which every daemon of the home checks at least every 30 seconds and exits on.
It reaches what the service manager cannot: a daemon on standby (it has no
endpoint), and, under WSL, a daemon whose Windows task was ended — ending
`wsl.exe` does not end the Linux process. `start` and `install` remove it; a
`schedule daemon` started by hand while it is there says so and exits.

A daemon that exits because of it exits **80**, which the systemd unit names in
`RestartPreventExitStatus=`: a stopped scheduler started again (by hand, or by
anything else) exits once instead of being restarted every ten seconds.
`schedule stop` also keeps the service from starting at the next login: it
**disables** the systemd unit (`systemctl --user disable --now`), the launchd
agent (`launchctl disable`, then `bootout`) and the Windows task, and `start`
enables them again.

## Upgrades

The daemon checks the installed CLI on every tick. After `npm i -g @namzu/cli`
or `namzu upgrade` it stops starting runs, waits for the runs it started, and
exits 0; the supervisor starts the new code. While it waits it does not evaluate
schedules either, so an occurrence that comes due during the wait is left to the
daemon that takes over: it runs late, or is recorded as missed under the job's
catch-up policy, and a one-shot still runs. A `schedule run-now` during the
wait, or one accepted earlier that was still waiting for a free slot or its
folder when the wait began, is queued on disk and started by the daemon that
takes over. The wait
lasts as long as the longest run in progress.

## Status

`namzu schedule status` shows the service, what the supervisor says, whether the
daemon answers (pid, version, standby, draining), the notification backend, the
number of jobs and runs in progress, each run waiting for approval with the
command that answers it (`awaitingApproval: [{ job, sessionId, resumeCommand,
waitingFor, handoff? }]` in `--json`; a run a page parked for you reads
`<job> needs you: <reason>; when that is done: <command>`, with
`handoff: { reason }`), the log file, and warnings: a node or CLI
path that no longer exists, or a CLI version that differs from the installed
one.

| Exit | Meaning |
|---|---|
| 0 | the daemon answers, or wrote its heartbeat in the last 90 seconds |
| 69 | installed, but the daemon is not running |
| 2 | not installed and not running |

The daemon's log is `schedule/daemon/log/daemon-YYYY-MM-DD.jsonl`, fourteen days
kept, with job names and ids only — never a prompt or a model's words. `namzu
schedule logs [--follow] [--job <name>]` reads it; `--run <id> --job <name>`
prints one run's own output.

The daemon answers `status`, `reload`, `run-now`, `stop` and
`drain-and-restart` on a loopback port whose address and token are in
`schedule/daemon/endpoint.json` (0600). Nothing on it carries a prompt or runs
a tool.

## Notifications

| Backend | When | How |
|---|---|---|
| `wsl-toast` | WSL with interop | a Windows toast through `powershell.exe`, via interop |
| `windows-toast` | Windows | the same toast |
| `macos` | macOS | `osascript` |
| `freedesktop` | Linux with a session bus | `notify-send`, else `gdbus` |
| `none` | none of these | `status` says why |

Title and body are data: they reach the other program as argv items or
environment variables, never as script text. The PowerShell script is a
constant sent with `-EncodedCommand` and nothing after it; under WSL the
variables are named in `WSLENV`, or Windows would receive them empty. A systemd
user service inside WSL gets no `WSL_*` variables, so it is told it runs in WSL
by the kernel, never the Linux session bus, which nothing in WSL displays. It
has no `WSL_INTEROP` either, so the daemon finds an interop socket itself —
`/run/WSL/1_interop`, which WSL links for systemd to the distro's init, else
the newest `/run/WSL/<pid>_interop` — and hands it to `powershell.exe` alone;
the daemon's environment, and a run's, stay as they were. `status` names the
socket beside the backend. With interop disabled or no socket there, the
backend is `none` with that reason. `status` shows the backend the daemon
reported in its heartbeat, not the one the shell running `status` would pick.

## Uninstall

`uninstall` stops the daemon, waits up to `--wait` (default ten minutes) for
runs in progress (`--interrupt-runs` does not wait; they finish on their own),
removes exactly what `schedule/service.json` lists, checks each piece is gone,
and removes the manifest last. On Windows and WSL that includes the `\namzu`
Task Scheduler folder `install` created, once no task is left in it
(`schtasks /Delete` removes the task, never its folder, and `schtasks /Query`
does not show an empty one). It exits non-zero and names anything it could not
remove. Jobs and history are kept unless `--purge-data`.

## Manual checks

Tested here on WSL2 (Arch Linux, systemd PID 1): both the Task Scheduler and the
systemd paths. On a Mac and on native Windows, run these once:

1. `namzu schedule install`, then `namzu schedule status` exits 0 within 30
   seconds.
2. `namzu schedule add probe --prompt "Say hello." --when "in 2m" --permissions
   read-only`, confirm, wait: `namzu schedule history probe` shows `completed`,
   a notification appeared, `cd <folder> && namzu resume <session>` opens the
   run.
3. Log out and in (macOS) or reboot (Windows): `status` is healthy again
   without anything typed.
4. macOS: a job whose folder is under `~/Documents` either runs or stops with a
   `blocked-config` naming privacy protection — never silently empty.
5. `namzu schedule uninstall --purge-data`: `launchctl print gui/$(id -u)/com.namzu.scheduler`
   or `schtasks /Query /TN \namzu\namzu-scheduler` finds nothing.
