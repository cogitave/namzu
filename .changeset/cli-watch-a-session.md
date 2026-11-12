---
"@namzu/cli": minor
---

New command `namzu watch [session]` follows a running or finished session from a second terminal on the same machine, read-only. It prints the conversation as a reopened one is drawn and keeps it current as the session's log grows; with no argument it offers the sessions with a turn in flight now, this folder's first. It never takes the session's lease, writes to its log, sends a message or answers an approval; a session that waits for one says what it waits for and that the answer belongs in the terminal that runs it. Text a step is still writing appears when that step ends, because the log holds only settled records. `--exit-on-end` leaves when the session ends with status 0 (finished), 1 (failed or stopped) or 69 (interrupted), `--plain` writes lines with no terminal control (the default when output is not a terminal), and Ctrl+C leaves with 130. Nothing changes for existing commands or flags.
