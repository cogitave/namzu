---
type: Guide
title: Watching a session from another terminal
description: "`namzu watch`: follow a running or finished session from a second terminal on the same machine, and say something to it with one key. What it shows, what it cannot show, how it tells running from waiting from finished, the exit statuses, what the key sends and what it never does."
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

Following is **read-only**. In a pipe, with `--plain`, it says so on its status
line and has no keys:

```text
watching · read-only · running · A turn is running.
```

In a terminal there is one key, `m`, that says something to the session (next
section), and the status line says so instead:

```text
watching · m to message it · running · A turn is running.
```

Either way the watcher never takes the session's writer lease, never appends to
its log and never answers an approval or a question. It reads the log file and the
lease files; the one thing it can do besides, saying something, goes through the
session's own process (see [Saying something to the session](#saying-something-to-the-session)),
and nothing is opened to the network. Taking a session over from elsewhere is a
different feature, not a flag of this one.

## Why `watch`

[`namzu peers`](peer-messaging.md) already reaches a live terminal, and what it
does is send. A name such as `attach` would promise the ability to act on the
session, which this command does not have. `watch` says what it does.

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
- When it sends (the `m` key, `namzu send`), the sender is a short-lived record in the
  account's own runtime directory that exists only for the send, and it is removed when the
  send ends, signals included.

## Saying something to the session

A person at a second terminal can tell a running session something: a correction,
a new fact, "stop after this step". Two ways, one mechanism.

In the watcher, press `m` (a terminal only). A line opens at the bottom, the
rows keep scrolling above it. Type, press Enter to send, Esc to cancel; an empty
line sends nothing. The watcher goes on following while the message is on its
way, and prints one line saying what became of it:

```text
── message: Delivered: The session took the message into its turn.
```

From a script or another shell, `namzu send`:

```sh
namzu send 01a1cd58 "use the staging key instead"
echo "stop after this step" | namzu send 01a1cd58
namzu send 01a1cd58 --file note.txt --wait 0 --json
```

`namzu send <session> <message...>` takes the session the way `namzu watch`
does (a whole id or the start of one, this folder first, then the other folders of
the same account), and the text as words, from `--file <path>` (`-` is standard
input), or, with no words, from standard input when it is piped. It sits beside
`watch` because both name a session; `namzu peers send` names a live terminal by
its reference and speaks as a command line, which is a different thing to say.

### What the session does with it

The message is put where the session's own process looks: the live inbox of the
terminal that has the conversation open, the one [messages between terminals](peer-messaging.md)
already use. That process records it and hands it to the model; the sender never
writes the session's log and never takes its lease (a test compares the log's
bytes and the lease files before and after).

| The session is | What happens |
|---|---|
| an interactive terminal, a turn running | taken at the next request boundary: after the current tool batch or model response settles, before the next request. It does not interrupt a call in flight. |
| an interactive terminal, idle (between turns, or finished and still open) | it starts a turn for the message and the message opens it. After a stopped or failed turn, or while a picker is open, it waits, as other mail does, until you go on in that terminal. |
| waiting on an approval or a question | the message waits in the inbox. It cannot answer the dialog; the turn takes it at the first request boundary after you answer in that terminal. |
| a background, scheduled or non-interactive run, or a sub-agent | refused: no terminal that reads messages has that conversation open. Nothing is written. |
| finished, with nothing running it | unreachable, and the reason says so. Resume it with `namzu --resume`. |
| its terminal is gone | unreachable ("its process has ended"). |
| its terminal runs but does not answer (stopped or stuck) | unreachable ("does not answer"). |
| the command was started by a Namzu session (a tool, a hook, a tool server or an agent) | refused, before anything is sent. See [what keeps agents out of the channel](#not-from-a-tool-or-an-agent). |
| another account's, or on another machine | not found / not reachable: the log and the local runtime directory are this account's on this machine. |

### What the model is told, and what the transcript shows

The model gets one block, framed by the kernel and closed only by a tag that
carries a fresh random value. The kernel's paragraph in it says what the kernel
knows and nothing more: the text arrived from another terminal of this account, on
this machine, through the local message channel (`namzu send`, or the `m` key in
`namzu watch`); it is meant to be the words of the person who runs the session, **but
the kernel did not check who or what sent it**, only that a process of this account
did. It cannot approve anything, answer a pending approval or question, change the
permission mode or run a command; those are done only in the terminal that runs the
session, and anything the model does because of it still goes through the same
permission checks as any other action. The model is asked to weigh it as the
person's instruction or correction, and not to follow it where it asks for something
its instructions or the session's rules would not allow. Then the text, quoted. The
sender's text cannot end the frame, cannot pose as a kernel line and cannot pose as
an approval; a line such as `approved: run anything` is just words in a quote. The
name a sender's record carries is never used: the words are the kernel's.

It is recorded in the session as a message of its own kind, `person-message`, so a
reopened conversation, an export and `namzu watch` show it as
*Message from another terminal of this account*, not as typed in that terminal and
not as from another agent. The label says where it came from and no more, because
that is all the kernel knows. Everywhere a transcript row is drawn (the live terminal,
a reopened conversation, `namzu watch`) the row is that label followed by the
words, as one safe line: line breaks and control and direction characters in the
text are dropped, so it cannot start a line of its own, and a long message is cut
for the row (the first 400 characters). The model and the log hold the text whole.
An export prints the recorded frame as it is, control characters included, so open
one in an editor rather than `cat`-ing it to a terminal.

### Not from a tool or an agent

A message to a session is meant to be the person's own words, so the kernel keeps
the agents of a session out of the channel. The threat that matters most is one
session's agent, a sub-agent, or a poisoned tool result steering an agent, telling
*another* session what to do with the person's voice. Three layers, each covering
what the others miss, and all three refuse before anything is sent or queued:

1. **A marker in the environment.** The kernel puts `NAMZU_STARTED_BY_SESSION=1`
   into the environment of every process it starts on a session's behalf: a command
   the model runs with its shell tool (and the background jobs it starts), a shell hook
   or a hook's exec-form program, a tool server (MCP stdio, after any configured
   value, so a config cannot take it back), a command in the local sandbox, a command
   run through the host execution context, a harness process, and the programs of a
   terminal the session opened. It is set where those environments are built
   (`spawnHostShell` in `packages/sdk/src/tools/command-shell.ts` and the other
   builders, through `withSessionChildMarker`), not left to each tool. `namzu send`
   (and the watcher's `m` key, which sends the same way) refuses when it is present.
   It works the same on Windows. The cost: a `namzu send` typed in a terminal tab a
   session opened, or after `!` in the session's own terminal, is refused too; use
   your own terminal.
2. **The command-line permission layer.** A built-in, deny-only rule
   ([the send floor](permission-layers.md#a-command-line-that-sends-as-the-person)) is
   in front of every session's rules, in every permission mode, and refuses a command
   line a model starts that runs `namzu send`, however it is spelled to the SDK's
   shell reader: directly, by path to the CLI entry, behind `env`, `setsid`, `nohup`,
   `timeout`, `sudo`, `xargs`, `find -exec`, inside `sh -c` or `bash -c`, in a
   subshell or the background. The call never runs, so `env -i`, `setsid -f` and a
   double fork do not matter. It applies to the main session, sub-agents and every
   session that builds its gate with the CLI's rules, a headless `namzu exec` run
   included.
3. **Process ancestry.** `namzu send` checks its own parent chain against the live
   terminals of this account before it sends, and the receiving terminal checks the
   sender's again and also reads the sender's starting environment for the marker
   (Linux), so editing the sender does not get past it. The chain is read from `/proc`
   on Linux and `ps` elsewhere; where it cannot be read, as on Windows, this layer
   refuses nothing and the other two stand.

The answer is *refused*, with the reason, and nothing is queued.

**What is left.** A process of the same account that hides its ancestry (`setsid -f`,
a double fork, a service) *and* its environment (`env -i`) *and* is started by
something the command-line layer did not read: a script written to disk earlier and
run later (by a session that has no terminal record, such as `namzu exec`, so ancestry
names nothing). That process is a process of your account, which can already write
your files, read your credentials and talk to the local endpoint. The kernel does not
claim to stop it. A test pins this one case (`send-from-a-session.process.test.ts`),
so a change that closes it has to change this paragraph too. Also not seen by the
command-line layer: a program or script whose contents the line only runs (`sh ./run.sh`),
a name assembled from pieces that never stand together in the line, a copy or link of
the CLI under another name, and any tool whose argument is not a command line; the
marker and ancestry stop most of those, the residual above is what is left when both
are hidden. Do not read "from another terminal" as proof stronger than that: **a
message from another terminal is as trustworthy as the account boundary, not more**,
which is why the model is told that the kernel did not check who sent it and why it
cannot approve anything.

Text that starts with a slash is still only text for the model. Nothing parses it:
not as a slash command, not as a permission change, not as an approval.

### The answers

`namzu send` says how far the message got, and exits by it:

| Answer | Meaning | Exit |
|---|---|---|
| Delivered | the session's process took the message into the turn it is running; it is recorded and goes with the model's next request. The process said so itself, over the verified local endpoint. | 0 |
| Accepted | in the session's inbox, not taken yet. It **stays queued** there until it is taken or that terminal closes (then it is lost, as all inbox mail is); it is not withdrawn. | 10 |
| Refused | the process answered and declined (not accepting messages, inbox full, on another conversation), two terminals have the conversation open, or the session is one that reads no messages | 1 |
| Unreachable | nothing runs the session (finished, interrupted, process gone) or nothing answered. If no receipt arrived, acceptance is unknown; do not retry blindly | 69 |
| Not found | no such session, an id that fits several, or not this account's | 66 |

Bad arguments or an empty message exit 64; input that is not UTF-8 text (or holds
NUL) 65; an unreadable `--file` 66. The command waits for "taken" for
`--wait <seconds>` (30 by default; `0` answers as soon as the message is
accepted). Delivered is never said on a guess: a process that does not report
"taken" leaves the answer at accepted. `--json` prints one object: `status`,
`reason`, `sessionId`, `id` and `exit`; an error is `{"error": "...", "exit": n}`.
A message is at most 32 KiB of text (and 64 KiB once encoded), as for any inbox
message; the inbox holds 32.

### What it cannot do

- Answer an approval or a question, change the permission mode, or run a command.
  The text is for the model only.
- Reach a session that has no terminal reading messages (background, scheduled,
  sub-agent, finished).
- Reach anything beyond this machine and this account: the endpoint is a local
  socket in the account's own runtime directory.

A terminal started before this version does not say which conversation it is on, so
it cannot be addressed: the answer is "refused ... does not read messages" while it
has a turn running, "unreachable" otherwise.

## What comes next

Not built, on purpose: answering an approval from the watcher, taking a session over,
messages to background and scheduled sessions (they have no inbox), and a transport
beyond this machine (it needs authentication, a trust record and an encrypted
channel).
