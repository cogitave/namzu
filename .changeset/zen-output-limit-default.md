---
"@namzu/zen": major
---

Remove the default 4096-token per-call output ceiling when `maxTokens` is
omitted. Requests now use the known model's advertised output ceiling instead
of selecting a smaller service default by omitting the wire field. Unknown
Chat, Responses and Google models without catalogue metadata leave the field
omitted. Messages requires `max_tokens`, so an unknown Messages model without
a known ceiling requires explicit `maxTokens` or model catalogue metadata.
Explicit limits remain unchanged and include manual thinking tokens on Messages.

Calls that relied on the previous default can produce longer output and consume
more tokens. Set `maxTokens: 4096` explicitly, or `maxResponseTokens: 4096` on
SDK turns, to preserve the previous behavior. Service and model limits still
apply. This fixes Pal requests where Space Bunny spent the 4096-token allowance
on reasoning and stopped before using tools, even with unlimited SDK turn guards.
