---
'@namzu/sdk': minor
---

The model call has a span.

There was none. `chatSpanName` shipped in the telemetry attributes with zero call sites, so a run's traces carried no LLM latency at all — and the one thing anybody opens a trace to find, which turn was slow and why, was the one thing not in it. The token counts landed on the iteration span, one level above the operation that spent them.

Each model call now opens `chat {model}` under its iteration span, parented explicitly because the loop body is an async generator and the ambient context at resume time belongs to the consumer, not to whoever created the run span.

It carries the request as sent — operation, provider, model, temperature, max tokens — and, once the turn settles, what came back: response model, response id, input and output tokens, the finish reason as an array per the convention, and cache read/write tokens. `RESPONSE_MODEL`, `RESPONSE_ID`, `REQUEST_TEMPERATURE`, `REQUEST_MAX_TOKENS`, `CACHE_READ_TOKENS` and `CACHE_WRITE_TOKENS` were all declared constants that nothing ever set.

The span closes on every path, including one the call threw on, using the same `finally` the iteration span now uses — with the duration still measured at the successful close so a healthy turn is not reported as lasting the whole iteration.

The iteration span keeps its own token attributes rather than having them moved. Something may already read them, and with one turn per iteration the two agree.
