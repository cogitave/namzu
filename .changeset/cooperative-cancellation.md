---
'@namzu/sdk': minor
'@namzu/anthropic': patch
'@namzu/openai': patch
'@namzu/openrouter': patch
'@namzu/http': patch
'@namzu/bedrock': patch
'@namzu/ollama': patch
'@namzu/lmstudio': patch
---

Make a Stop abort the IN-FLIGHT model turn, not only between turns.

`ChatCompletionParams` gains an optional `signal?: AbortSignal`. The query
runtime threads the run's abort signal into every provider call (the streaming
turn and the forced-final summary) and now drives the provider stream through a
MANUAL iterator that RACES each `next()` against the abort — so a cancellation
tears the turn down within a tick even if a transport buffers or ignores the
signal, with the abort propagating out of the generator so the run settles as
`cancelled`. The stream consumer cleans up on every exit (removes the abort
listener, calls `iterator.return()`), and the natural-completion break
re-checks the signal so a Stop that lands exactly as the turn finishes is
recorded as cancelled rather than a normal end-of-turn.

Every provider now honours the signal at the transport: Anthropic
(`messages.create({ signal })`), OpenAI (`create(..., { signal })`), Bedrock
(`send(..., { abortSignal })`), OpenRouter + HTTP (compose with the request
timeout via `AbortSignal.any`), Ollama (the returned iterator's `.abort()`),
and LM Studio (`respond(..., { signal })` → the SDK's websocket cancel) — each
plus a cheap per-chunk `signal.throwIfAborted()` for promptness.

Fully additive and inert when unset: a never-aborted signal is behaviourally
identical to omitting it, so existing callers and uncancelled runs are
byte-identical.
