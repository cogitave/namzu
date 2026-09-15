---
"@namzu/zen": patch
---

Fix two error-classification bugs in the Zen driver that could misreport a genuine upstream failure (`overloaded`/`5xx`) as an unreachable-network one, or an unreachable-network one as an upstream server failure, depending on how the connection actually failed.

- **A connection Zen's own SDK layer never got any HTTP response on (a transport failure such as `ECONNREFUSED`, or a proxy reset) is now classified `provider.network` ("could not reach the provider"), not `provider.unavailable` ("the provider is failing on its own side").** The driver used to default a missing status code to a fabricated `502`, which read as a genuine 5xx from the provider and pointed an operator at "resume once it recovers" for a request that in fact never reached the wire at all.
- **A client-side timeout or aborted request (what a `fetch` call rejects with when `AbortSignal.timeout` fires — the shape behind Zen's free/anonymous models occasionally not answering in time) now keeps the platform's real reason in the error's `detail`** instead of the generic fallback "The model stream failed." (`message`/`name` on that rejection live on the prototype, not as own properties, and the driver's own fingerprinting was reading only own properties).
- **Every classified failure from a `chatStream` call now names the model in its message and `detail`** (e.g. `model "big-pickle": …`), so a run juggling more than one model — or a log line read without the status line above it — still says which request failed. `providerId` (`"zen"` / `"zen-go"`) is unchanged; nothing keys on it differently.

No public API changes. Nothing here indicates a Zen catalogue problem: `big-pickle` and every other listed model are unaffected by this fix, which only corrects how an already-thrown failure is classified and described.
