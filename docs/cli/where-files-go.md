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

This is guidance, not enforcement: it changes no permission. Only the
schedule tool refuses the home folder as a task directory.

## The home-folder line

When the working folder of a session is exactly the home folder, the
transcript gets one system line at start: "Working in your home folder: files
go straight into it. Open a project folder to keep work in one place." At the
filesystem root the line says so in the same words. It shows once per
session, in the interactive terminal UI only; `exec` and other headless runs
print nothing extra.
