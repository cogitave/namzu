---
'@namzu/sdk': minor
---

A tool result can now be screened before anything reads it

Step one of #399 framed a connector's result with the server's name. Nothing read the frame. This is the thing that reads it — and it is the only boundary that can see an **indirect** injection at all: a payload arriving in a fetched page or a connected server's answer is never in the run's input, so the input-side screen is not merely missing it, it structurally cannot reach it.

`ToolRegistryConfig.resultGuardrails` runs against every tool result. Position matters and is structural rather than incidental: the registry returns to the executor, the executor applies the output budget and spills what is over it, and compaction summarises later still. A summariser does not distinguish trusted text from untrusted, and content carried into a summary outlives the result it came from.

**Two refusals, not one.** At a run boundary `block` can only mean "end the run". At a tool boundary the useful refusal is usually the other one:

- `refuse` — recoverable. The `tool_use` fails carrying the reason and the model can choose something else. Not blank and not dropped: a model shown an empty result concludes the tool found nothing, which is a different claim and a false one.
- `halt` — terminal, and throws `ToolResultHalted`. It has to throw, because the registry's failure path turns every exception into a result the model reads and works around — a halt reported as a failed call would be silently demoted to a refuse.

`rewrite` is for **redaction** — a credential that should not enter context, removed at the last boundary before it does. It is not for neutralising an injection: editing an attack presumes you understood the payload well enough to defang it. The two are the same mechanism and only the discipline separates them, which is why it is written down.

A screen that throws **fails closed** as `refuse`, matching the run-level guardrails: one broken screen means this result's safety is unknown, not that the run is unsalvageable.

**New:** `ToolResultGuardrail`, `ToolResultGuardrailContext`, `ToolResultGuardrailSpec`, `ToolResultVerdict`, `ToolResultHalted`, and a `toolResultInjectionGuardrail()` preset over the same pattern list the input-side screen uses.

**Nothing changes unless you configure it.** With no guardrails a result is returned exactly as the tool produced it, and there is a test pinning that — adding the control must not change any existing host's behaviour on upgrade.

**How to reach it.** Construct the registry with the screens and hand it in:

```ts
runAgent({
  tools: new ToolRegistry({ resultGuardrails: [toolResultInjectionGuardrail()] }),
  …
})
```

Stated plainly because it is asymmetric with `inputGuardrails` / `outputGuardrails`, which are set on the run config. A host that looks for `toolResultGuardrails` beside those will not find it. Closing that gap means the run config reaching a registry it did not construct, which is a separate change.

**Detection is partial and the preset says so.** An injection phrased as ordinary prose, or in a language the pattern list does not cover, passes. Pattern-matching and delimiting both measure poorly against an attacker who adapts. This raises the cost of the lazy attack; it is not a boundary, and it should not be described as one.
