---
'@namzu/sdk': patch
---

Parent the OpenTelemetry spans, and emit the missing `chat` span.

Every span was a root. A repo-wide grep for `context.with` / `trace.setSpan`
returned zero hits, so a single 20-iteration run landed in Honeycomb as 21
disconnected root spans plus N orphan tool spans — no waterfall, no way to see
which iteration a slow tool belonged to. There was no span around the model
call at all: `chatSpanName` existed with zero call sites, so traces carried no
LLM latency, and the token counts were stamped on the iteration span instead of
the operation that produced them.

The fix is explicit parent contexts rather than `startActiveSpan`. Every
span-owning body in the run loop is an async **generator**, and a generator
resumes on its consumer's async context — so the ambient parent is already gone
by the time a child span is created, and the naive conversion silently parents
nothing. `parentContext(span)` threads it as a value instead.

- Iteration spans parent to the run span; tool spans parent to the iteration
  that requested them, via a new optional `ToolContext.parentSpan` (already
  threaded to exactly the right place).
- A `chat {model}` span carries `gen_ai.operation.name`, request model,
  temperature and max tokens, and on completion the response model, id,
  finish reasons, token usage and the cache-read/write counts.
- `@namzu/telemetry` switches from `SimpleSpanProcessor` to
  `BatchSpanProcessor`, so exporting a span no longer puts network latency
  inline on the agent loop.

Adds the first telemetry tests in the repo.
