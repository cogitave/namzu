---
'@namzu/sdk': minor
---

Stop an optional inference from ending the run that made it.

`PreparationTextRequest.timeoutMs` is deprecated and no longer bounds the request. An
auxiliary provider request that ends without its final usage receipt leaves the run's shared
token ledger unresolved, and an account with unresolved spend admits nothing further — so a
deadline that fired in normal use did not bound the call, it stopped the run. Against a
reasoning model whose auxiliary answer took 17 s, every turn after the first ended with
"usage for a model request could not be confirmed" before the model was ever asked, so no
tool call in the run could ever execute.

What a host observes: a run that used to stop after its first turn now continues. A
preparation or review inference is bounded by the provider's own request timeout and by the
run's cancellation — the same two bounds every other model request in the run has — instead
of by a 10 s deadline of its own; set `runConfig.timeoutMs` to bound the whole turn. Stop
still cancels an in-flight auxiliary call, and a cancelled call still leaves its unresolved
receipt visible in `/cost`. Passing `timeoutMs` changes nothing and is still validated; the
field will be removed in a later major.
