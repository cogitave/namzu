---
type: Reference
title: Where files go
description: The standing guidance that sends everything that is not part of the request to the session's scratch folder, tells a session to ask before touching the home folder or root top level, and the quiet line shown when a session starts there.
resource: packages/cli/src/context/file-placement.ts
tags: [cli, system-prompt, files, startup]
status: stable
generated: { by: human:bahadirarda, at: 2026-11-10T00:00:00Z }
---

# Where files go

A session that is asked to set something up has to decide where its files
live, and a session that is asked to run a build or merge some data leaves
logs, helper scripts, saved output and staging folders behind. Without a rule
it picks a folder of its own, often the working directory or the home folder,
unmentioned. Every session now carries a short section, **Where files go**,
in the cached part of its system prompt, next to the working doctrine.

The section is two paragraphs, the same on every platform and every turn, so
the prompt prefix stays byte-stable. It says:

- What is not part of the request goes in the session's scratch folder (its
  path is one of the environment facts), never in the working directory or the
  home folder: logs, saved output, helper and reproduction scripts,
  intermediate data, backup copies and staging folders.
- The shared temp folder is for when the person asks.
- A file the person asked for goes where they said, or where the project keeps
  such files.
- A backup copy goes in the scratch folder, not beside the file. (An
  interactive session also records each file before a tool changes it; see
  [File checkpoints](file-checkpoints.md). Exec and ephemeral sessions have no
  such rewind, which is why the rule does not lean on it.)
- The person is given the full path only when they need
  it, such as where a file was saved or what to open. Nothing else is
  narrated: the working rules tell the model to answer about the work, not
  about the machine, the session or the scratch folder (see
  [Staying quiet about the setting](#staying-quiet-about-the-setting)).
- Never create or delete a top-level entry in the home folder or the
  filesystem root without asking.

The working rules say the same about a reproduction script: it stays in the
scratch folder unless it becomes a test in the project.

## The scratch folder is always there

Every session that runs commands on this machine has a scratch folder from
the moment its first turn starts, whatever the kind of session: the terminal,
`exec` (including `--json` and `--no-session-persistence`), the ACP host that
Desktop uses, a Pal and a scheduled run. It is
`<temp base>/namzu-<user>/<project>/<session>/scratchpad`, made with mode 0700
and refused when a link or another user's folder is in the way (see
[Session storage](session-storage.md#where-scratch-files-go)). A sub-agent
uses its parent's folder. Its path is in the environment facts of every one of
those sessions, and `write` and `edit` into it are not asked about. The path is
long (the project folder is encoded into it), so a command also gets
`$NAMZU_SCRATCH`, a short link `<temp base>/namzu-<user>/s-<8 hex>` to the same
folder; the prompt says to use it in shell commands. The long path stays the
real one, and when the link cannot be made `$NAMZU_SCRATCH` is the long path.

A session that keeps nothing else on disk (`exec --no-session-persistence`,
`exec --json` without a store) still gets the folder, under the same temporary
root and with the same layout. It is a temporary folder: the operating system
clears it with the rest of its temporary files, and Namzu does not remove it
when the process ends, so a file there can still be read after the run. A
session that runs its commands in a sandbox does not have it (the folder is
not mounted there) and its prompt does not name one.

Background command output is kept there too: each job's whole output is
written to `<scratch>/jobs/<job id>.log` and the path is given to the model
when the job starts and in every `job` and `wait_for_job` result (see
[Background jobs](background-jobs.md#where-a-jobs-output-is-kept)).

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

## Staying quiet about the setting

The environment facts (date, branch, scratch folder, machine, shell, sandbox)
are for the model's own use. The block ends its framing line with "Do not
narrate them unless asked or relevant", and the first-turn environment reminder says the same. The working
rules (`### Keeping the user informed`) add one rule: answer about the work;
name a path only when the person needs it; never describe the machine, the
sandbox, the session, scratch folders or which tools were used unless asked;
an empty folder or a search that finds nothing is a clause, then the answer;
a greeting is one short line. The Desktop preview note says to write the file
and say in a line what it is, and the conversation-search guidance says an
empty search is not a result to report.
