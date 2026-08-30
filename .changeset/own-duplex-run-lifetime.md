---
'@namzu/sdk': major
---

Make `startBidiRun()` own the complete duplex lifetime. Caller cancellation,
manual close and provider closure now fence local admission, abort active tool
contexts, close a late or active provider session once, and refuse duplicate
tool-call ids before a side effect can run twice.

**What breaks:** `BidiRun.close()` no longer waits for tool implementations
that ignore their cancellation signal, and provider cleanup now has a
five-second default bound. Set `closeTimeoutMs: 0` to retain the former
unbounded provider-close wait. Providers must treat entering
`sendToolResult()` as an atomic publication boundary and resolve it only after
the result was accepted.

The new `BidiSessionCloseTimeoutError` distinguishes a locally fenced run whose
provider cleanup could not be confirmed before the configured bound.
