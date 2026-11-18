---
type: Reference
title: Where files go
description: The two-line standing guidance that tells a session where to put what it creates and to ask before touching the home folder or root top level, and the quiet line shown when a session starts there.
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

The section is two lines, the same on every platform and every turn, so the
prompt prefix stays byte-stable. It says:

- Temporary work goes in the session scratchpad or the OS temp folder, and the
  person is told the full path of every folder created.
- Never create or delete a top-level entry in the home folder or the
  filesystem root without asking.

It used to carry per-platform folder lists, a container and repository
paragraph and a nine-line checklist for anything that keeps running (service
account, configuration, data, logs, supervisor, secrets, retention,
monitoring, host) with a receipt at the end. Most turns never install a
service, so that advice is no longer sent; a model asked to set one up works
from its own knowledge of the platform.

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
