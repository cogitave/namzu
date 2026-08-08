---
'@namzu/sdk': major
---

**The run record names the member that served.** After a provider chain fell
over, `run.metadata.provider` and every step's `model` still named the head. The
wire and the metering followed the member that answered; the durable record did
not, so a run read back six months later said the primary served a turn it never
saw. A missing field reads as unknown and a wrong one reads as a fact.

**What is major: `StepResult.model` reports a different value.** It now names
the model the step **asked for** — the run's configured model, or a
`prepareStep` override. It used to be the run's model unconditionally, so a host
that routed one step to a cheaper model read the expensive one back out of the
ledger. That defect needed no chain to see. Nothing stops compiling; the value
changes. If you were reading `step.model` to recover the run's configured model,
read `run.metadata.config.model`, which has always held it.

**New, and additive:**

- `StepResult.servedBy` — `{ providerId, model, chainIndex }`, who actually
  answered the step. Equal to `model` and to `run.metadata.provider` on every
  run without a chain; it diverges exactly when the chain advanced.
  `chainIndex` is the member's position in the chain you declared (`0` is the
  head) and is carried because a chain may name the same provider twice with
  two models, which `providerId` alone cannot tell apart.
- `RunStateMetadata.servingProvider` — the member the run was routed to at the
  end, absent when the configured provider served throughout.
  `RunStateMetadata.provider` is unchanged and still names what you configured:
  what was asked for and what answered are two facts, and collapsing them into
  one field is how the original defect was made.
- `WithProviderFallbackOptions.onSwap` and the `ServingMember` type, for a host
  composing `withProviderFallback` itself.

**Two limits, stated rather than papered over.** The loop records a step only
for a tool-calling turn, so the turn that produces the final answer is not in
`steps` — on a chain that falls over and answers immediately,
`metadata.servingProvider` is the only record of the swap. And the built-in disk
store writes `metadata`, not `steps`: per-step provenance reaches you on the
returned `Run`, so persist that if you need it.

**Nothing is backfilled.** Records written by 17.0.0 could fall over without
recording it, so their `servedBy` is absent and their `servingProvider` reads as
"no swap" whether or not there was one; the transcript's `provider_fallback`
events are the record for those runs. Filling them in from the declared head
would state as fact the exact thing that release got wrong, on exactly the runs
where it was wrong.
