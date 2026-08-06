---
'@namzu/sdk': patch
---

`StdioTransport.close()` resolves when the child is gone, not when the signal
was sent.

It called `kill('SIGTERM')` and returned. `kill()` returns as soon as the
signal is delivered, so an awaited `close()` meant "SIGTERM is on its way", and
a caller that closed a transport and then deleted the child's working directory
raced the exit — reported as `EBUSY` from a real integration, not inferred. A
close that does not mean closed makes every teardown built on it a guess, and
the guess is only wrong sometimes.

`close()` now waits for the child's `exit`. A child ignoring SIGTERM is sent
SIGKILL after two seconds, and a second timer gives up waiting, so `close()`
cannot hang; both timers are unreferenced, so neither holds the event loop
open. A spawn that never produced a process emits `error` and no `exit`, and
that path settles too rather than waiting for an event that is not coming.
