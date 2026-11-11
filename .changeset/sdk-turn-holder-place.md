---
"@namzu/sdk": minor
---

A turn's writer lease now names where its process id is valid. The holder was `namzu:<pid>:<turnId>`; it is now `namzu:<pid>:<turnId>@<place>`, where the place is a 12-character token for the machine's host name and, on Linux, the process-id namespace. The beginning is unchanged, so a reader of `namzu:<pid>:` still matches; a reader that compares the whole holder to a turn id, or takes everything after the second colon as the turn id, now sees the `@<place>` suffix and should use `parseTurnHolder` instead. New exports: `turnHolder(turnId, options?)` builds a holder, `parseTurnHolder(holder)` returns `{ pid, turnId, place? }` (no `place` for a holder written before this change, `null` for a name that is not a turn's), and `currentPlace()` gives this process's place. A host may treat a dead process id as proof that a holder is gone only when the holder's place equals its own `currentPlace()`; a holder with no place, or another place, is never proof.
