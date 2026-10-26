---
"@namzu/cli": patch
---

`read_conversation` now recovers only from a bad offset. An integrity or ownership refusal on a read that carried a `byteOffset` is no longer retried from the start; the model gets the generic "could not be read" answer and the cause goes to the host log. Probe reads are counted against the per-call byte limit exactly once. A seq far past the end of the conversation is answered with the highest retained seq whichever source serves the read, a page that is not the whole record says which call continues it, and an expired cursor's note says that earlier pages repeat. Nothing to do on upgrade.
