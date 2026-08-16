---
'@namzu/sdk': minor
'@namzu/openrouter': minor
---

A driver can now say how large a model's context window is, and the kernel
ranks that above its hand-maintained table.

That table was the only source below an explicit host config, and its own
header records what it cost: every Claude entry carried 200k including the
1M-window models, so those runs compacted at roughly 14% full and threw
away the prompt-cache prefix to do it. Every model release drifts it again
until somebody edits it — while the OpenRouter driver was already parsing
the vendor's real `context_length` and discarding it, because there was no
member to return it through.

`LLMProvider.resolveContextWindow?(model, signal)` is three-state like
`effortLevelsFor`: absent means this driver cannot answer, a resolved
`undefined` means it asked and does not know, a number is the answer. A
driver resolving `undefined` falls through to the TABLE, not to the
assumed default — asking must never be worse than not asking.

Resolved once per run, at the door. Both consumers are synchronous and in
the hot loop, so this can never become an await inside it. A driver that
rejects or hangs does not fail the run: the window is an optimisation over
a working default.

`ResolvedContextWindow['source']` and the `windowSource` on
`token_usage_updated` gain `'provider'`, ranked between `'config'` and
`'model-table'`, so a host can see which route a number came from.

Also fixes a hole this exposed: `withProviderRetry` and
`withProviderFallback` forwarded `listModels`, `healthCheck` and
`doctorCheck` but not `effortLevelsFor`. A dropped optional member does not
fail — it reads as "this driver cannot answer" — and retry is on by
default, so a driver's declared effort levels were invisible on
essentially every run.
