---
type: Reference
title: Where files go
description: The standing guidance that tells a session where to put what it creates, the checklist for anything that keeps running, and the quiet line shown when a session starts in the home folder or the filesystem root.
resource: packages/cli/src/context/file-placement.ts
tags: [cli, system-prompt, files, startup]
status: stable
generated: { by: human:bahadirarda, at: 2026-11-10T00:00:00Z }
---

# Where files go

A session that is asked to set something up has to decide where its files
live. Without a rule it picks a folder of its own and may leave it in the home
folder, unmentioned. Every session now carries a short section, **Where files
go**, in the cached part of its system prompt, next to the working doctrine.

The section is built once at start from the platform alone, so it renders only
that platform's lines and never changes mid-session; the prompt prefix stays
byte-stable. It says:

- Temporary work goes in the session scratchpad or the OS temp folder.
- App data, config, caches and logs follow the platform: `~/.config`,
  `~/.local/share`, `~/.local/state`, `~/.cache` on Linux;
  `~/Library/Application Support`, `Caches`, `Logs` on macOS; `%APPDATA%` and
  `%LOCALAPPDATA%` on Windows. A system-wide service uses `/opt/<app>`,
  `/etc/<app>`, `/var/lib/<app>`, `/var/log/<app>` under systemd, a
  LaunchDaemon on macOS, or a Windows service.
- A container stack keeps its compose and config files in a dedicated, named
  project folder the person agrees to, and its data in named volumes.
- A repository the person will work on goes in their projects folder; ask when
  it is not known.
- Never create or delete a top-level entry in the home folder or the
  filesystem root without asking, even when tools run without approval.
- Say the full path of every folder created; `rm -rf` only a path this session
  created and checked.
- Anything long-running (a service, daemon, container stack or agent) is
  checked against one line each for identity, configuration, data, logs,
  supervisor, secrets, state, monitoring and host, and any deviation (no
  root, a personal machine) is named with its reason.
- A finished setup ends with a receipt: what was installed, where, how it
  starts, how to remove it.

The guidance is backed by a check in code, below. The schedule tool also
refuses the home folder as a task directory.

## The home folder and the root are asked about

A call that would create or delete a top-level entry (the first name below the
home folder, or below `/`) is asked of a person in every mode, `bypass`
included, with the path named. It joins the questions no mode answers in
advance (see [Permission modes](permission-modes.md#what-bypass-and-auto-still-ask)):
it is listed with protected paths, never covered by "Yes, and don't ask again"
or a standing yes, and refused where nobody can be asked (`exec`, a scheduled
run) with a message that says why.

Asked about: `mkdir ~/newthing` (also `mkdir -p ~/newthing/sub`),
`git clone <url> ~/repo` (or a clone into the home folder when it is the
working folder), `touch`, `cp`, `mv` or a redirect into a new name, `rm` or
`mv` of an existing top-level entry, and the `write` and `edit` tools creating
a new file there. The same at the filesystem root.

Not asked about: anything inside a top-level entry that exists
(`~/projects/x/new`, `/tmp/x`, the session scratchpad), and changing a
top-level entry that is already there.

Limits. Only what can be read before the line runs counts: a path built from a
variable or a command substitution is not judged, so it does not prompt on
every command, and a relative path after a `cd` in the same line is not
judged either. The check runs where outside paths are reviewed (the
interactive CLI) and not inside a sandbox, whose paths are the guest's.

To proceed: work in a project folder (create it with your own `!mkdir`, or
answer yes when asked), or tell the session which folder to use. A rule cannot
waive this question; it is not an `allow`-able command.

## The home-folder line

When the working folder of a session is exactly the home folder, the
transcript gets one system line at start: "Working in your home folder: files
go straight into it. Open a project folder to keep work in one place." At the
filesystem root the line says so in the same words. It shows once per
session, in the interactive terminal UI only; `exec` and other headless runs
print nothing extra.
