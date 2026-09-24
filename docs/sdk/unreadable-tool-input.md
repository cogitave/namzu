---
type: Reference
title: Unreadable tool input
description: How a streamed tool call whose arguments do not parse is classified (truncated or malformed), what the model and the host are told, and the tool fields that shape the message.
resource: packages/sdk/src/runtime/query/iteration/stream-turn.ts
tags: [sdk, tools, streaming, providers]
status: stable
generated: { by: process:claude-code, at: 2026-09-24T00:00:00Z }
---

# Unreadable tool input

A model streams a tool call's arguments as JSON fragments. The turn loop
(`streamProviderTurn`) joins them and parses the result once the call is
complete. Sometimes the text does not parse. The call is then not run: its
`function.arguments` becomes `"{}"`, and the model is told what went wrong so
it can send the call again.

## Truncated or malformed

The reason is decided by how the response ended, never by the text. A buffer
that stops mid-string looks the same whether the output limit cut it off or
the model closed its turn early. Only the finish reason tells them apart.

| Finish reason the stream reported | `inputError.reason` |
|---|---|
| `length` (output limit) | `truncated` |
| `content_filter` | `truncated` |
| none: the stream ended or failed before its last frame | `truncated` |
| `stop` or `tool_calls` (a normal finish) | `malformed` |

A content-filter stop counts as `truncated` because the provider stopped the
response before the model closed its arguments. The JSON was not the model's
mistake.

A driver may close a call's block before it reports the finish reason. The
Messages API closes an open `tool_use` block and only then says `max_tokens`.
So a call whose arguments fail to parse at the block close gets its
`tool_input_completed` event when the stream ends, not at the block close.

Before this distinction, every parse failure was reported as a cut-off. A model
whose JSON was malformed, on a response that finished normally, was told to
send less. That does not fix malformed JSON.

## What a host sees

`ToolCall.metadata` on the assistant message:

- `inputTruncated: true`: the arguments could not be read. It is set for both
  reasons. The name is older than the distinction, and existing readers keep
  working.
- `inputError`: a `ToolInputError`, with fields `reason`, `finishReason`
  (absent when the stream reported none), `parseError` (the JSON parser's
  message), `offset` and `length`. `offset` is where parsing stopped: the
  whole length when the text simply ended, and absent when the parser did not
  say. `length` counts the characters of arguments that arrived.
- `partialArguments`: everything that arrived. A `repairToolCall` hook is given
  this text.

The `tool_input_completed` event carries the same `inputTruncated` and
`inputError`, plus `partialArguments` cut to its first 16 384 characters. The
event is written to the session log, and a cut-off `write` can hold a whole
file. `inputError.length` gives the full size. The SSE bridge sends them on
`tool.input_completed` as `input_truncated`, `input_error` and
`partial_arguments`.

A call recorded before `inputError` existed has only `inputTruncated`. It is
answered without a reason.

## What the model is told

The message is assembled from the reason and from the tool:

- **Malformed.** The parser's error, and the character where parsing stopped
  when the error does not already name it. Then: send the call again with the
  arguments as one valid JSON object. It gives no size advice.
- **Truncated.** What stopped the response (the output token limit, a content
  filter, or the stream ending), after how many characters. After an output
  limit or a stream that ended, it adds a size budget if the tool declares
  large string arguments. Otherwise the model is told to send the call again,
  and after an output limit, with less text before it. After a content filter
  it adds no advice.
- The tool's own `unreadableInputHint`, when it declares one, for either
  reason.

A tool declares what it needs on its definition or through `defineTool`:

```ts
import { defineTool } from '@namzu/sdk'
import { z } from 'zod'

export const saveNote = defineTool({
	name: 'save_note',
	description: 'Save a note to the project notebook.',
	inputSchema: z.object({ title: z.string(), body: z.string() }),
	// The argument that can be long, and the characters one call should keep it under.
	largeStringArguments: { body: 8_000 },
	// Appended for a truncated or a malformed call.
	unreadableInputHint: 'Save a long note as several notes with numbered titles.',
	category: 'custom',
	permissions: [],
	readOnly: false,
	destructive: false,
	concurrencySafe: true,
	async execute({ title }) {
		return { success: true, output: `Saved ${title}.` }
	},
})
```

After an output-limit cut, a declared budget larger than half of what arrived
is lowered to that half. A budget the response could not hold would lead to the
same cut again.

The built-in tools that take long text declare it: `write` (`content`), `edit`
(`old_string`, `new_string`), `create_task` and the coordinator `Agent` tool
(`prompt`), and the CLI's `Agent` tool (`prompt`), each with a 12 000-character
budget and its own hint. Any other tool, such as a question or plan tool, gets
no size advice and no file-writing advice.

## A stream that breaks tool-call framing

Every driver promises one call per `index` and the call's id before its
arguments. The turn loop and `collectChatCompletion` refuse a stream that
breaks either promise:

- a second call id on an index another call holds, whose arguments used to be
  appended to the first call's;
- arguments before the call's id, which used to be dropped.

The turn loop throws a `ProviderRequestError` with `kind: 'server'`. Its
`detail` names the violation, for example
`the stream reused tool-call index 0 for call "call_b" while call "call_a" held it`.
Tool calls are not recovered from such a stream. `collectChatCompletion`
throws an `Error` with the same sentence. The same id repeated on every
fragment is accepted.

## Finish reasons from the drivers

The classification depends on each driver reporting how the response ended:

- `@namzu/anthropic` and the HTTP driver's Anthropic dialect: `max_tokens` and
  `model_context_window_exceeded` are reported as `length`, and `refusal` as
  `content_filter`. `@namzu/anthropic` no longer fails the stream when a tool
  call's JSON does not parse. Its search-replay record parsed every block's
  input and threw, so the block close and the finish reason never arrived, and
  every such call was reported as cut off.
- `@namzu/bedrock`: `model_context_window_exceeded` is reported as `length`,
  and `guardrail_intervened` as `content_filter`. A tool call opens with the id
  the driver keeps, including the one it makes up when the wire has none.
- `@namzu/http` (OpenAI dialect) and `@namzu/openrouter`: `finish_reason` is
  mapped instead of cast. `function_call` becomes `tool_calls`, and an unknown
  value becomes `stop`. OpenRouter's `error` fails the stream.
- `@namzu/deepseek`: `insufficient_system_resource` fails the stream instead of
  reading as `stop`.
- `@namzu/openai` Codex: `response.incomplete` is reported as `length`, or
  `content_filter` when that is the stated reason. It carries no replay state.
- `MockLLMProvider`: a `truncateArguments` call sends half its arguments and
  the turn finishes with `length` unless the script sets `finishReason`.
