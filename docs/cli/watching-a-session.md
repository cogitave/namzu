---
type: Guide
title: Watching a session from another terminal
description: "`namzu watch`: follow a running or finished session read-only from a second terminal on the same machine. What it shows, what it cannot show, how it tells running from waiting from finished, the exit statuses, and what it never does."
resource: packages/cli/src/commands/watch.ts
tags: [cli, sessions, watch, read-only]
status: stable
generated: { by: process:claude-code, at: 2026-11-12T00:00:00Z }
---

# Watching a session from another terminal

A session that runs in one terminal, in the background or under a
[schedule](scheduled-tasks.md) can be looked at from a second terminal while it
runs. `namzu watch` prints the conversation the way a reopened one is drawn and
keeps it up to date as the session's log grows.

```sh
namzu watch                      # offers the sessions with a turn in flight now
namzu watch 01a1cd58             # a whole session id, or the start of one
namzu watch 01a1cd58 --exit-on-end --plain | tee run.txt
```

It is **read-only**, and says so on its status line:

```text
watching · read-only · running · A turn is running.
```

It never takes the session's writer lease, never appends to its log, never
sends a message and never answers an approval or a question. It reads the log
file and the lease files, nothing else; no socket is opened and nothing is
opened to the network. Steering a session from elsewhere is a different
feature, not a flag of this one.

## Why `watch`

[`namzu peers`](peer-messaging.md) already reaches a live terminal, and what it
does is send. A name such as `attach` would promise the ability to act, which
this command does not have. `watch` says what it does.

## Choosing the session

With no argument, `namzu watch` lists the sessions that have a turn in flight
now, this folder's first and then newest first. One session: it is watched. Several: a
terminal asks which, with a number; a pipe prints the list and exits 64 rather than
guess. None: it says so and exits 66.

A session is "running now" when its writer lease is live, which is true while a
turn runs. A session between turns holds no lease, so it is not offered, but it can be
watched by id, and so can a finished one. An argument is a whole id or the start
of one; a start that fits several sessions is refused and the candidates are named.
This folder is searched first, then the other folders of the same account on this
machine. Only root sessions are addressed. A sub-agent's work is in its parent's
rows, and a scheduled run is an ordinary session titled `Scheduled: <job> · <time>`.

## What it shows

The rows are the ones a reopened conversation gets: the same projection of the
session's messages and journal, so a change to how a step is drawn reaches the
watcher too. They are printed once, as scrollback. Tool output and other expandable
detail stays folded.

**Steps appear as they settle.** The session's log holds a message when its step
ends, a tool's events as they happen, the boundaries of turns and the
questions put to a person. The text a model is writing right now, and a tool's
progress, are live events that are never appended to the log. A watcher
cannot show what is not on disk: text being written appears when its step
ends, and the header says so. It does not pretend to stream.

If the session rewrites its history (a compaction replaces older messages), the
watcher says so and draws the conversation again from the top. A grouped row at the
end of a running turn is held back until something follows it, because it may still
grow.

Everything that came from the session passes through the same display escaping the
terminal screen uses, so control characters and direction marks show as `\u{…}` and
cannot move the cursor or recolour the watcher's screen.

## State

| State | Means | From |
|---|---|---|
| `running` | a turn is in flight and its writer is alive: the lease is live and the process it names still exists | the open turn in the log, the lease, the holder's pid |
| `waiting` | the turn waits for a person, or is parked | an unanswered `decision_requested`, a `turn_paused` |
| `finished` | the last turn settled (the sentence says how: finished, failed, stopped by the person, or stopped early) | `turn_completed`, `turn_failed` |
| `interrupted` | the turn never ended and nothing holds the session any more | an open turn whose lease lapsed or whose holder process is gone |
| `idle` | no turn has run yet | |

These are the facts the session list uses: the turn the log leaves open, and whether
its writer's lease is still live. A process killed outright holds its lease until it lapses
(see [Session storage](session-storage.md)), which is minutes. The watcher reads only
sessions of this machine, so it also asks whether the process the lease names still exists
(a signal-zero probe, which sends nothing) and reads a session whose holder is gone as
`interrupted` at once. It asks only for a holder that says it ran in this place (the mark at
the end of the holder's name, see [Session log](../sdk/session-log.md)): a holder written on
another machine or in another process-id namespace that shares the folder, or by a version
that did not write the mark, is judged by its lease alone. A pid that another process has
since taken reads as alive until the lease lapses.

A tool call that has started and not yet reported a result is in flight, not interrupted:
it is held back, with the rows after it, until it settles, and the session reads `running`.

A log whose first record cannot be verified (changed in place, or reached through a
link, which is not followed) is refused with exit 66 and nothing of it is shown, rather
than shown as an idle session. A session is announced only once it has been read and
found to be this account's.

When the session waits for an approval or a question, the status line says what it is
waiting for in the kernel's words (the question's own text, or "approve the call to
bash") and where to answer it: **in the terminal that runs the session**. The
watcher cannot answer it.

## After the session ends

By default the watcher stays open: a new turn in the same session shows up, and the
status line says it is still watching. `Ctrl+C` leaves cleanly, with exit status 130,
and the session is not touched.

For scripts, `--exit-on-end` leaves when a turn settles or its writer is gone:

| Exit | Meaning |
|---|---|
| 0 | the last turn finished |
| 1 | the last turn failed, was stopped, or stopped before finishing its work |
| 69 | interrupted: the process that ran the turn is gone and it never ended |
| 130 | stopped with `Ctrl+C` or a signal |
| 64 | bad arguments, or several sessions run and none was named in a pipe |
| 66 | no such session, none to offer, or one that is not this account's |

A session that waits for a person has not ended, so `--exit-on-end` goes on
following it; put a limit on the command from outside (`timeout`) when a script
cannot wait. A turn that settles and is followed at once by another (a goal that
continues itself) reads as ended in between.

`--plain` writes plain lines with no terminal control: no status line is redrawn, and
a line starting `[watch]` marks each change of state. It is the default when
standard output is not a terminal.

## How it follows

The log is append-only. The watcher reads only the bytes after the last record it
verified, and reads the whole log again from the start if it got shorter or is another
file now (a writer cut a torn tail). It waits on the file system's change
notifications for the project folder and the session folder, and also on a one second
timer, because a notification can be missed and a lease lapsing changes no file. A
quiet poll draws nothing.

## Safety

- It reads only sessions of this account on this machine, through the same ownership check
  the session list uses: a log whose project or tenant is not this installation's is refused.
- It opens the project documents and logs for reading and creates nothing: no index, no
  identity, no project folder.

## What comes next

Not built, on purpose: sending a message to the session from the watcher (it needs the
peer inbox's admission rules and an attributed, approval-free message), and a transport
beyond this machine (it needs authentication, a trust record and an encrypted channel).
See [Messages between live terminals](peer-messaging.md) for the first.
