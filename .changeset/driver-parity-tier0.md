---
'@namzu/anthropic': patch
'@namzu/openai': patch
'@namzu/http': patch
---

Three driver defects found by auditing every provider against the same
contract checklist rather than one at a time.

**anthropic — a thinking block never reported its close.** `openReasoning`
was declared, read by the `content_block_stop` branch, and never added to:
three references in the whole file. The set was permanently empty, so the
close branch could not match and `reasoning: { done: true }` never reached
the consumer. A host that opens a thinking card on the first reasoning
delta left it spinning for the rest of the run. Stored blocks were
unaffected, so replay always looked correct — only the live stream was
broken, which is why it survived. This is the default driver.

**openai — every request to a reasoning-family model failed on turn one.**
`temperature` and `max_tokens` were sent unconditionally, and those models
reject both, requiring `max_completion_tokens`. The rejection is a 400,
which classifies as `invalid_request` and is not retryable, so the run
died immediately whenever a token cap was set — which the runtime always
does. Model family is now detected by id prefix, conservatively: an
unknown model keeps the standard parameters, because a false positive
silently strips `temperature` from a model that honours it while a false
negative produces a clear error naming the parameter.

**http — every streamed turn reported zero tokens.** The body builder never
requested usage on a streamed response, so a conforming endpoint sent none
and the (complete) parsing had nothing to parse. Cost read as free, and any
budget or compaction threshold keyed on usage never fired however large the
thread grew.
