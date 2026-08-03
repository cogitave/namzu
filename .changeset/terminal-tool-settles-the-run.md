---
'@namzu/sdk': minor
---

A tool can declare that its output IS the answer

Every delegation path is blocking: the worker's final text comes back as the dispatching call's result. The loop then went round once more purely to restate what the worker had already said — a full model call at the parent's context size, the most expensive call in the run. It is also lossy, because the parent paraphrases the worker's answer through its own compacted view, so the caller receives the summary rather than the answer. For a router agent, whose entire job is to pick a specialist, that doubled the cost of every request.

`terminal: true` on a tool settles the run with that tool's output — the rule `structured_output` has always had, now available to any tool. `buildAgentTool({ terminal: true })` sets it on the built-in delegation tool.

It is honoured only when the terminal call is the only call in the turn and it did not fail. A model that asked for other work in the same turn meant to see those results, and settling would discard answers it requested; an error is not an answer either, and the model is the one that should read it. Both cases take the ordinary path and log the reason rather than quietly costing the relay the flag was set to avoid.

`defineTool` also gained `maxRetries` and `outputSchema` passthrough. Both fields were already read by the runtime, and the sanctioned way to author a tool had no way to set either — the documented "the tool author opts in, per tool" was reachable only by hand-writing the interface.
