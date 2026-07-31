---
'@namzu/sdk': minor
'@namzu/anthropic': minor
'@namzu/openai': patch
'@namzu/ollama': patch
---

Widen the message model to content blocks: multimodal tool results, `is_error`,
and reasoning replay.

`ToolMessage.content` was `string` and `AssistantMessage` had no slot for
reasoning, so three separate things died at the provider boundary. Doing them
as one migration is deliberate — all three need the same widening, and every
stored transcript, checkpoint and `messages.json` is written in the narrow
shape, so the cost only grows.

**Tool results can carry non-text content.** `ToolResultContent` is
`string | ToolResultBlock[]`, where a block is text, image or document. String
stays first-class: the common case is unchanged and every existing tool and
driver compiles untouched. `@namzu/computer-use`'s `screenshot` returned
~400 KB–2.7 MB of base64 **as text** — roughly 100k–670k tokens of characters
no model can decode — so computer use was effectively non-functional; it now
returns an image block with a short textual description. MCP `image` and
inline `resource` blocks are passed through instead of being filtered out.

**Failures are marked on the wire.** The executor computed `isError`, routed it
to the SSE bridge, the A2A bridge and the TUI, then dropped it at the provider
boundary — so the model's trained tool-failure recovery never fired. The
Anthropic driver now sends `is_error: true`, and the value survives the
executor's result tuple, which previously narrowed to `{toolCallId, output}`
before the message was built.

**Reasoning is representable and replayed verbatim.** `AssistantMessage.reasoning`
holds opaque `ReasoningBlock`s (thinking / redacted, with signature or encrypted
payload). The Anthropic driver used to rebuild every assistant turn as
`[text?, ...tool_use]` — precisely the pattern the verbatim-echo contract
prohibits when a `tool_result` follows — and now emits stored reasoning blocks
first, signature intact.

Drivers that cannot express non-text tool results (`@namzu/openai`,
`@namzu/ollama`) degrade through `toolResultToText`, which renders an explicit
`[image: …]` placeholder rather than dumping base64 or silently dropping it.

This is the outbound half. The Anthropic driver does not yet parse thinking
blocks out of the stream and `ChatCompletionParams` has no `thinking` field,
so `reasoning` is populated only when a caller supplies it.
