---
'@namzu/sandbox': major
---

**Closing a terminal now kills everything the terminal started.** That is the
one change here you did not ask for, and it is why this is a major. Before it,
tearing a terminal down sent `SIGKILL` to the process group of util-linux
`script` — and `script` starts the shell in a **new session**, so the kill
reached `script` alone. `script`, the shell and the foreground job then died of
the PTY hanging up, but a job backgrounded with `&` was never signalled: it
kept running with no terminal, holding its port, reachable by no op, until the
pod stopped. The agent's own comment claimed that kill reached "the shell and
every descendant". It now does: both a session kill and a plain terminal's
teardown signal every process still in the kernel session the shell was
started in, found through `/proc`. **If you were relying on that leak** —
starting a dev server with `&` inside a terminal and expecting it to survive
the terminal — move it to `startDetached` below, which is the verb for a
program meant to outlive its caller. Nothing else about a plain `openTerminal`
changed, down to the wire request it sends.

**What is new: a workspace terminal or program can outlive the host process.**
A workspace is built to outlive the host — it carries no lease for exactly
that reason — but the processes inside it were not. A terminal belonged to one
connection, so a deploy, a crash or an OOM kill tore down every terminal the
host had open. Replay was buffered in the host process, so its successor had
neither the output nor a way to name the terminal. And nothing could run
outside a terminal at all: `exec` caps at thirty minutes and kills the process
group when the cap fires.

All of it is on `KubernetesWorkspace`. `@namzu/sdk` is unchanged, and so is
every other backend, the Firecracker tier included.

- `openTerminal({ ...options, sessionId, persistent: true })` hands the PTY to
  the guest's session registry. Closing the connection then DETACHES and sends
  no signal of any kind; the session ends when its program exits, on
  `killSession`, or when the pod stops.
- `attachTerminal(sessionId, { fromOffset, size })` rejoins it from any
  process, replaying what it missed and then following live, with input and
  resize working after the attach. At most one attachment exists at a time: a
  second attach ends the first by name, so two host processes cannot
  interleave keystrokes into one shell.
- `startDetached({ sessionId, command, args, cwd, env })` starts a program with
  no PTY, stdin closed, in its own kernel session. `readSession(sessionId, {
  fromOffset })` answers in the SDK's `BackgroundJobOutput` shape (`chunk`,
  `nextOffset`, `droppedBytes`, `status`, `exitCode`) — and a read is not an
  attachment: it displaces nobody and signals nothing, so polling a shell's
  tail leaves the terminal reading it alone. `listSessions()` names what is
  running, and `killSession(sessionId, { signal })` ends one and everything
  still in it; `signal` is one of `SIGTERM`, `SIGKILL`, `SIGINT` or `SIGHUP`
  and anything else is coerced to `SIGTERM`, the same on every connection.
- Exported: `KubernetesSessionsUnsupportedError`,
  `KubernetesSessionRefusedError`, `AgentSessionDetachedError`,
  `SESSIONS_FEATURE`, plus the option and row types
  (`KubernetesOpenTerminalOptions`, `KubernetesAttachTerminalOptions`,
  `KubernetesStartDetachedOptions`, `KubernetesReadSessionOptions`,
  `KubernetesKillSessionOptions`, `KubernetesSessionSummary`,
  `KubernetesSessionOutput`, `KubernetesWorkspaceTerminal`,
  `KubernetesSessionTerminal`, `KubernetesSessionRefusal`, `SessionKind`,
  `SessionState`, `SessionDetachReason`).

**`exited` on a session terminal can reject.** When the attachment ends and the
program does not — the connection was lost, or another process took the
session — it rejects with `AgentSessionDetachedError`, carrying the byte offset
to come back at. Resolving it would report an exit that never happened, which
is the confusion this whole feature exists to remove. A connection-bound
terminal's `exited` is unchanged.

**What you have to know before relying on it.** The registry is the pod's
memory and is never written to disk, so `listSessions()` is empty after
`suspend()` and `resume()`, and after any eviction, node drain or restart:
this makes a program survive the HOST, not the pod. A session's output ring is
the same `OutputLog` a detached execution uses — one monotonic byte-offset
space, eviction reported as `droppedBytes`, never a shorter stream that looks
complete — and output is read into it whether or not anybody is attached, so a
program with no reader never blocks on a full PTY. No signal can follow a
process that called `setsid` for itself: it has left the session, and nothing
short of a PID namespace or a cgroup reaches it.

**`spawnDetached` is still absent, deliberately.** It returns a host
`ChildProcess` synchronously and its consumer keeps jobs in a map inside one
host process, so it cannot express a hand-off between processes. `startDetached`
has a different name because it does a different thing: it returns a NAME, and
the name is what a redeployed host comes back with.

**Redeploy the workspace image to get it.** The guest advertises `sessions` in
its `healthz` features, and a host asking for any session verb against an older
image is refused with `KubernetesSessionsUnsupportedError` — never downgraded
to a connection-bound terminal. The guest wire protocol version is deliberately
**unchanged**: `sessionId`, `persistent` and the four new ops
(`attach-session`, `start-detached`, `list-sessions`, `kill-session`) are all
additive, so no host and no image has to roll together with this release.

Three variables join the shipped workspace template's `env` block at their
defaults, so deleting them changes nothing: `NAMZU_AGENT_MAX_SESSIONS` (16
sessions at once), `NAMZU_AGENT_SESSION_LOG_BYTES` (1 MiB of retained output
each) and `NAMZU_AGENT_SESSION_TERMINAL_TTL_MS` (10 minutes an exited
session's record and output outlive it). The first two bound what the registry
can cost the container's 512Mi; a session exists only when a caller names one,
so a deployment that never asks for one pays nothing.
