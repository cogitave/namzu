---
'@namzu/cli': minor
---

`/clear` and `/new` now tell your hooks. The conversation you leave gets `session_end` with the reason `clear`, and the new one gets `session_start` with the source `clear` (at its first turn, as a new conversation does). The context a `session_start` hook gave for the old conversation no longer carries into the new one: the new conversation carries what its own `session_start` hooks print, or nothing. The end hook has the same short deadline as on exit (five seconds when the entry names no `timeoutMs`) and never delays the new conversation. A `matcher` of `clear` (or `startup|resume|clear`) on `session_start`, and `clear` on `session_end`, picks these out.

`/resume`, `/fork` and branching from an earlier prompt in the terminal now also end the old conversation for the hooks (`session_end`, reason `replaced`) and start the other (`session_start`, source `resume`, or `startup` if it holds no turn), and drop the old session-start context the same way.

If you have a `session_end` hook with no `matcher` that cleans up when you leave for good (removes a lock, stops a helper), it now also runs on `/clear`, `/resume` and `/fork`: give it `matcher: "exit"` to keep the old behaviour. A `session_start` hook with no `matcher` now also runs for each of these. A Pal's conversation runs no hooks, as before.
