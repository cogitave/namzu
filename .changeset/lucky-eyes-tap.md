---
'@namzu/sdk': minor
---

Make `MockLLMProvider` a scriptable test model that can emit tool calls.

The mock accepted `{ model, responseText, responseDelayMs }` and emitted 8-char
text slices. It never yielded `delta.toolCalls`, and `MOCK_CAPABILITIES`
declared `supportsTools: false`, so capability negotiation stripped the tool
surface before a request was even built. A consumer writing a custom tool had
no supported way to test that the agent loop calls it, that its error string
comes back as a `tool_result`, or that the model retries — and namzu's own
maintainers hand-rolled **eight** `implements LLMProvider` fakes across seven
test files to work around it, each re-implementing the delta bucketing and
`toolCallEnd` framing that `streamProviderTurn` exists to hide.

`MockProviderConfig` now takes `turns: MockTurn[]`, where a turn carries text,
tool calls, a finish reason, usage, and failure injection. Tool calls are
emitted with the frame sequence a real driver produces — per-tool `index`, id
and name first, then argument fragments, then the block-close signal — so a
test exercises the real consumer path instead of a shortcut through it.

- `truncateArguments` reproduces a tool call cut off mid-JSON at `max_tokens`.
- `error` fails the request with a status (for retry tests);
  `throwAfterChunks` fails mid-stream (for recovery tests).
- `nextTurn(params, i)` decides each turn from the request that triggered it;
  `onRequest` and `provider.requests` capture what the runtime actually sent,
  so a test can assert on `tools`, `toolChoice` or `cacheControl`.
- A script shorter than the run repeats its last turn, so a loop bug reads as
  repetition rather than an exhausted-script crash.
- `supportsTools` / `supportsFunctionCalling` are now `true`.

The old `responseText` shorthand still works and becomes a one-turn script.
