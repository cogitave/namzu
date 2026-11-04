---
"@namzu/sdk": minor
"@namzu/cli": minor
---

A full disk no longer ends a session. When appending to the session log fails with `ENOSPC`, `EDQUOT` or `EROFS`, the turn keeps going: the unwritten records wait in an in-memory buffer (8 MiB by default, `degradedBufferBytes` on the log options; the oldest are dropped past it), every later record retries the write, and when the disk accepts writes again the buffer is written in order. Any other write error is raised as before.

What it costs: while the volume is refusing writes, a restart or crash resumes from the last record that reached the disk, and if the buffer overflowed the log has a gap where the dropped records were (a strict reader reports the break, a `tolerant` read stops at it). A large message body that cannot be spilled beside the log is kept as its preview with a note, instead of failing the turn.

New live events, both ephemeral and never recorded: `session_log_degraded` (SSE `session_log.degraded`) and `session_log_recovered` (SSE `session_log.recovered`). A consumer that switches exhaustively over `SessionEvent['type']` must handle them (or ignore them); the A2A bridge declines both. `SessionLog` gains an optional `onWriteHealth(listener)`. The CLI shows one row when writes start failing ("Transcript writes are failing (the disk is full). Recent messages may not be saved for resume.") and one when they work again; it never asks you to start a new session.
