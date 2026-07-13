---
"@namzu/sdk": minor
---

**A cancelled run no longer tells the wire it completed.** `completeRun` skipped `markCompleted` for a cancelled run — so the record was right — but emitted `run_completed` anyway. Every cancellation, including the in-process `signal.abort()` path, told every stream consumer the run had finished successfully.

Cancellation gets its own terminal event, `run_cancelled`, rather than a field on `run_completed` that a consumer has to remember to read: an event a client can ignore by omission is a lie that ships by default. Both bridges map it to the state that actually means cancelled (the exhaustive mapped type over `RunEvent['type']` made that compiler-enforced, not a matter of remembering).

**Breaking for exhaustive consumers**: `RunEvent` gains `run_cancelled`. Code that switches exhaustively over run events must handle it. A client that treated `run_completed` as "it worked" was already wrong on every cancel; it now finds out at compile time.
