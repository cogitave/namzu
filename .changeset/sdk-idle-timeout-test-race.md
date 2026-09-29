---
'@namzu/sdk': patch
'@namzu/cli': patch
---

Background jobs whose process cannot start now emit one exit update after the child closes, without reporting the spawn error as a process exit code. An error on a process that already started no longer marks its job as exited while it is still running. SDK API signatures are unchanged.

Completed and aborted job or delegated-task waits release their polling timers instead of keeping them alive for the rest of a long session. Idle-stream, agent front-door, awaited-job and large-input lexer regression tests now avoid real-time races that could fail on a busy CI runner.

The CLI's background-child and scheduled-run integration tests now wait for the event they assert, leaving their normal process deadline to Vitest instead of letting a short poll or unrelated watchdog decide the outcome.
