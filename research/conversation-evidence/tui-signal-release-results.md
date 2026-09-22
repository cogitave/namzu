# A TUI stopped by a signal gives its conversation back — real-TUI verification

Date: 2026-09-22

Drives the interactive TUI (`packages/cli/dist/bin.js`) under a real PTY with
`tui-signal-release-drive.py`: a trusted folder, a provider preference pointing
at a local chat-completions endpoint that lists one model and never answers a
completion, the prompt `hi` typed a character at a time. Once the completion
request has arrived the turn is certainly mid-flight; the driver then stops the
TUI and, with the SDK's `DiskSessionLog`, reads the session's active turn and
tries to claim its writer lease, as `/abandon`, `/resume` or the next process
would. SIGHUP is produced the way a terminal produces it: the driver closes the
PTY master.

Session ids are omitted from the output below.

## Before (the build without `packages/cli/src/termination.ts` wired into `launchTui`)

```
== SIGTERM
before signal: [{"active":"running","claimed":"not tried","tail":["iteration_started","request_envelope","message_started"]}]
child ended: signal SIGTERM after 0.06 s
after exit: [{"active":"running","claimed":false,"tail":["iteration_started","request_envelope","message_started"]}]
terminal after exit: ICANON True ECHO True
cursor shown at the end: True
resume hint printed: False
```

The process is gone, yet the turn still reads `running` and the lease cannot be
taken: the conversation stays blocked until the five-minute lease expires.

## After

```
== SIGTERM
before signal: [{"active":"running","claimed":"not tried","tail":["iteration_started","request_envelope","message_started"]}]
child ended: signal SIGTERM after 0.08 s
after exit: [{"active":"interrupted","claimed":true,"tail":["iteration_started","request_envelope","message_started"]}]
terminal after exit: ICANON True ECHO True
cursor shown at the end: True
resume hint printed: True
== SIGHUP
before signal: [{"active":"running","claimed":"not tried","tail":["iteration_started","request_envelope","message_started"]}]
child ended: signal SIGHUP after 0.05 s
after exit: [{"active":"interrupted","claimed":true,"tail":["iteration_started","request_envelope","message_started"]}]
== SIGINT
before signal: [{"active":"running","claimed":"not tried","tail":["iteration_started","request_envelope","message_started"]}]
child ended: signal SIGINT after 0.08 s
after exit: [{"active":"interrupted","claimed":true,"tail":["iteration_started","request_envelope","message_started"]}]
terminal after exit: ICANON True ECHO True
cursor shown at the end: True
resume hint printed: True
```

- The process still dies of the signal it was sent, well inside a
  supervisor's grace period.
- The turn reads `interrupted` and the lease is taken at once.
- Nothing was appended for the turn by the dying process (the log's last
  three records are unchanged), so the next writer decides how it closes.
- The terminal is back in canonical mode with echo and a visible cursor, and
  on SIGTERM and SIGINT the resume handoff is printed. On SIGHUP there is no
  terminal to check or print to.

The same behaviour for `namzu run` and `namzu run-stream` is asserted by
`packages/cli/src/commands/__tests__/a-terminated-run-lets-go-of-its-turn.test.ts`.
