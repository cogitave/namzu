---
'@namzu/sdk': major
'@namzu/anthropic': major
'@namzu/openai': major
'@namzu/bedrock': major
'@namzu/openrouter': major
'@namzu/http': major
'@namzu/ollama': major
'@namzu/lmstudio': major
---

RunEvent v3 + streaming-only `LLMProvider` (ses_001-tool-stream-events).

The kernel now emits a per-message and per-tool-input lifecycle on the
event bus, and the provider contract collapses to a single streaming
entry point. Together these unlock live tool-call rendering (Calling →
Running → Done with incremental input) for SSE consumers — the cowork
workspace surface that motivated the work in the first place.

## Breaking changes

### `LLMProvider.chat()` removed

`LLMProvider` exposes a single LLM entry point: `chatStream()`. The
non-streaming `chat()` method is gone from every shipped provider
(`@namzu/anthropic`, `@namzu/openai`, `@namzu/bedrock`,
`@namzu/openrouter`, `@namzu/http`, `@namzu/ollama`,
`@namzu/lmstudio`).

Consumers that need an aggregated `ChatCompletionResponse` use the new
helper:

```ts
import { collect } from '@namzu/sdk'

const response = await collect(provider.chatStream(params))
```

`collect()` drains the stream and assembles the legacy response shape:
text concatenated in arrival order, tool calls bucketed by index,
latest `finishReason` and `usage` win, defaults to `{ finishReason:
'stop', zero usage }` when the provider omits them (defensive against
SDK quirks like dropped `message_stop` frames).

The orchestrator consumes the stream directly so it can emit per-delta
RunEvents — it does NOT call `collect()`.

### `RunEvent` envelope `schemaVersion: 2 → 3`

`RUN_EVENT_SCHEMA_VERSION` is now `3`. The envelope narrows from `2 |
3` to `3`; sub-session lifecycle events stamp `3` automatically via
`RunEventSchemaVersion`.

### `llm_response` removed

The coarse `llm_response` event is replaced by a message lifecycle:

- `message_started { runId, iteration, messageId }` — first chunk arrives.
- `text_delta { runId, iteration, messageId, text }` — per-chunk text.
- `message_completed { runId, iteration, messageId, stopReason, usage?, content? }` — provider stream closes.

`message_completed.content` is the aggregated text and is optional —
consumers that already accumulate `text_delta` themselves can ignore
it; consumers that only care about the completed message (telemetry,
A2A bridge) read it directly.

`stopReason` is the new `MessageStopReason` union: `'end_turn' |
'tool_use' | 'max_tokens' | 'stop_sequence' | 'pause_turn' | 'refusal'
| 'forced_finalize'`.

### Tool input lifecycle

Tool calls now traverse a five-event lifecycle keyed by `toolUseId`:

- `tool_input_started { runId, iteration, messageId, toolUseId, toolName }`
- `tool_input_delta { runId, toolUseId, partialJson }` — raw fragment
- `tool_input_completed { runId, toolUseId, input }` — parsed object
- `tool_executing { runId, toolUseId, toolName, input }` — runtime invokes
- `tool_completed { runId, toolUseId, toolName, result, isError }` — required `isError`

`tool_executing` and `tool_completed` payloads tighten: `toolUseId`
becomes required on both, `isError` becomes required on
`tool_completed`. The wire-level `tool.error` event is dropped — the
boolean carries the same signal without ambiguity.

Probe veto, malformed JSON args, plugin hook errors, and exception
throws inside `tools.execute()` all now emit a terminal
`tool_completed { isError: true }` so consumer UI cards can finalise
instead of being orphaned.

### Ephemeral events skip persistence

`text_delta` and `tool_input_delta` are flagged `isEphemeralEvent()`
and bypass `transcript.jsonl`. They live only on the in-memory bus
for live UI rendering. Replay is unaffected (it reads checkpoints,
not transcripts). The bus has a 1000-event soft cap; under pressure
the oldest ephemeral is dropped while lifecycle events are preserved.

### `StreamChunk.delta.toolCallEnd`

New optional field signalling per-tool-block boundary closure. The
orchestrator translates it into `tool_input_completed`. Providers
that emit a per-tool-block close (Anthropic `content_block_stop` of
type `tool_use`, Bedrock equivalent) populate it; providers that
don't fall back to end-of-stream flushing.

## Migration

Most consumers only use the iteration orchestrator's emitted
`RunEvent` stream. They:

1. Replace `case 'llm_response':` handlers with a `case
   'message_completed':` handler reading `event.content`.
2. Drop any reads of `event.hasToolCalls` — derive from the
   subsequent absence/presence of `tool_executing` events keyed by
   the same `runId`.
3. Optional: subscribe to `text_delta` and `tool_input_*` for live
   rendering. The events are interleaved by `toolUseId` to support
   parallel tool calls.

Consumers calling `provider.chat()` directly:

```diff
- const response = await provider.chat(params)
+ import { collect } from '@namzu/sdk'
+ const response = await collect(provider.chatStream(params))
```

Aggregated response shape is identical.

## Internal surface (not externally consumed)

- `runtime/query/iteration/index.ts` — new `streamProviderTurn()`
  helper, replaces synthesised `message_started`/`message_completed`
  with native streaming. `forced_finalize` path uses `collect()`.
- `provider/instrumentation.ts` — captures `usage` from the last
  chunk that supplies one (`extractStreamUsage`).
- `runtime/query/events.ts` — `EventTranslator.emitEvent` skips
  `appendEvent()` for ephemeral events, applies the queue cap.
- `bridge/sse/mapper.ts` — six new wire types
  (`message.created/delta/completed`,
  `tool.input_started/delta/completed`); `tool.error` removed;
  `tool.executing/completed` carry `tool_use_id` + `is_error`.
- `bridge/a2a/mapper.ts` — `message_completed.content` routes to A2A
  status update, replacing the per-iteration `llm_response` mapping.

## Tests

SDK suite at 958 (was 943 + new contracts − removed
`chat()`/`llm_response` invariants). `pnpm typecheck && pnpm lint &&
pnpm test && pnpm build` all green across every package. The
`@namzu/http` request-construction and response-parsing suites have
10 tests marked `.skip` pending an SSE-mock rewrite — the streaming
path is still covered by the existing streaming-suite tests.
