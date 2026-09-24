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
  message), `offset`, `length` and `responseLength`. `offset` is where parsing
  stopped: the first character that cannot continue valid JSON, or the whole
  length when the text simply ended. It is found by scanning the arguments,
  not read from the parser's message, which names no position for a bare
  token such as Python's `True` or `None` or JavaScript's `undefined` or
  `NaN`. `length` counts the characters of arguments that
  arrived. `responseLength` counts the characters the whole response streamed
  before it stopped: its text, its visible reasoning and every tool call's
  arguments, this call's included.
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
  arguments as one valid JSON object, and the tool's own `malformedInputHint`
  if it declares one. It gives no size advice, because size does not fix
  malformed JSON.
- **Truncated by the output limit.** What stopped the response, after how many
  characters of arguments. Then it depends on what filled the response:
  - The call was less than half of it (`length` against `responseLength`):
    the model is told that most of the response went to what came before the
    call, and to send the call again with less before it. Nothing about the
    call's own size.
  - Otherwise the call itself has to carry less. A tool that declares large
    string arguments is given a budget for each; any other tool is told to
    keep its arguments under half of what arrived, in all. Then the tool's own
    `truncatedInputHint`, if it declares one.
- **Truncated by the stream ending.** The declared budgets, if the tool has
  any, or just to send the call again. Then the tool's `truncatedInputHint`.
- **Stopped by a content filter.** No advice and no hint: sending less does
  not get past a filter.

Before, a tool that declared no large arguments was always told to send less
text before the call. A `bash` heredoc, a `run_code` body or an MCP tool's
long input that filled the response on its own was sent back the same size,
into the same cut.

A tool declares what it needs on its definition or through `defineTool`:

```ts
import { defineTool } from '@namzu/sdk'
import { z } from 'zod'

export const saveNote = defineTool({
	name: 'save_note',
	description: 'Save a note to the project notebook.',
	inputSchema: z.object({ title: z.string(), body: z.string(), tags: z.array(z.string()) }),
	// The argument that can be long, and the characters one call should keep it under.
	largeStringArguments: { body: 8_000 },
	// Appended when a call was cut off and sending less gets past it.
	truncatedInputHint: 'Save a long note as several notes with numbered titles.',
	// Appended when the arguments were not valid JSON.
	malformedInputHint: 'Pass "tags" as a JSON array of strings.',
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
same cut again. The budget sentence says how much, and the hint says how:
splitting fits a file body and not a delegated prompt, so the kernel does not
say to split.

The built-in tools that take long text declare it: `write` (`content`), `edit`
(`old_string`, `new_string`), `create_task` and the coordinator `Agent` tool
(`prompt`), and the CLI's `Agent` tool (`prompt`), each with a 12 000-character
budget and a `truncatedInputHint`: for `write`, extend a short opening with
`edit` calls; for `edit`, several smaller edits; for the `Agent` tools, name a
file instead of pasting its content. None declares a `malformedInputHint`, so
a malformed call to any of them, or one a content filter stopped, gets no
advice about size or files. Any other tool, such as a question or plan tool,
gets no file-writing advice, and a size budget only for its arguments as a
whole, when they filled the response.

## Tool-call framing

A stream groups a call's fragments by `index`. The turn loop and
`collectChatCompletion` both rely on that, and on nothing else:

- Arguments that arrive before the call's id are kept for the call at their
  index. The id is filled in when it arrives. `collectChatCompletion` always
  did this. The turn loop used to drop such fragments with a warning, so what
  was left failed to parse and the call was reported as cut off. It now keeps
  them and sends them in one `tool_input_delta` right after
  `tool_input_started`, once the call's id and name are both known. No
  `tool_input_delta` comes before its call's `tool_input_started`.
- A second call id on an index another call holds is refused. The second
  call's arguments used to be appended to the first call's, which left one
  call that no tool could run. The turn loop throws a `ProviderRequestError`
  with `kind: 'server'`, and `collectChatCompletion` throws an `Error`. Both
  name the violation, for example
  `the stream reused tool-call index 0 for call "call_b" while call "call_a" held it`.
  Tool calls are not recovered from such a stream. The same id repeated on
  every fragment is accepted.
- A call whose id never arrives, on a fragment or on the block close
  (`toolCallEnd`), is given one by the turn loop when the stream ends, and
  announced then. It used to reach the executor with an empty id, which no
  tool result can name, and without its arguments. `collectChatCompletion`
  returns such a call with an empty `id`, as it always has.

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
