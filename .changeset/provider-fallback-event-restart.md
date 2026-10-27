---
'@namzu/sdk': minor
'@namzu/cli': patch
---

The `provider_fallback` session event now carries `restart: true` when the chain member that failed had streamed only pieces that can be taken back (reasoning, or a tool call still being written). A host that draws the reply as it streams should drop what that member showed, as it does for a `provider_retry` with `restart: true`. The field is optional and absent otherwise, so a host that ignores it behaves as before. The terminal app takes the half-drawn reply back when it is set.
