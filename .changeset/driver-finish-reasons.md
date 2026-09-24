---
'@namzu/anthropic': patch
'@namzu/bedrock': patch
'@namzu/http': patch
'@namzu/openrouter': patch
'@namzu/deepseek': patch
'@namzu/openai': patch
'@namzu/google': patch
---

The drivers now report more accurately how a response ended. The runtime uses this to tell a tool call the output limit cut off from one the model wrote badly.

- `@namzu/anthropic`: a tool call whose JSON does not parse no longer fails the whole stream with "the provider stream returned malformed data". The block close and the finish reason now reach the runtime. `model_context_window_exceeded` is reported as `length`, and `refusal` as `content_filter`. Both used to read as a normal `stop`.
- `@namzu/bedrock`: `model_context_window_exceeded` is reported as `length`, and `guardrail_intervened` as `content_filter`. A tool call opens with the id the driver keeps, so its arguments never arrive before an id.
- `@namzu/http`: the OpenAI dialect maps `finish_reason` instead of passing the server's string through. `function_call` becomes `tool_calls`, and any value outside the four becomes `stop`. The Anthropic dialect gets the Anthropic mapping above and opens a tool call with the id its arguments carry.
- `@namzu/openrouter`: `finish_reason` is mapped the same way. `error` (the upstream model failed mid-generation) now fails the stream with a `ProviderRequestError` (`kind: 'server'`).
- `@namzu/deepseek`: `insufficient_system_resource` now fails the stream with a `ProviderRequestError` (`kind: 'server'`). It used to read as a finished answer.
- `@namzu/openai`: Codex's `response.incomplete` is reported as `length`, or as `content_filter` when that is the stated reason, with its usage. The stream used to end with no finish reason, so auto-continuation never ran.
- `@namzu/anthropic`, `@namzu/bedrock` and `@namzu/http`'s Anthropic dialect: a `model_context_window_exceeded` stop also carries `finishDetail: 'context_window'`, so the runtime does not ask the model to continue a reply that filled the whole context window.
- `@namzu/anthropic`, `@namzu/google` and `@namzu/openai` (Codex): the list of sources a driver appends after a hosted search now carries `contentOrigin: 'driver'` on its stream chunk. The text is unchanged. Without the mark, a tool call the output limit cut off before that list would be reported as malformed.

If you branch on `finishReason`, expect `length` or `content_filter` where you saw `stop` for these cases.
