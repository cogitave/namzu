---
type: Reference
title: Assistant text phases
description: Separate public progress from settled answers while retaining original message items and native replay.
resource: packages/sdk/src/provider/stream-text.ts
tags: [sdk, providers, streaming, context]
---

# Assistant text phases

Some providers return several public assistant message items in one response.
An intermediate explanation can repeat the eventual answer. Flattening both
items into a string makes the completed result repeat itself and can make an
auxiliary JSON answer unparsable.

`AssistantTextPart` contains an item `id`, its `text`, and an optional
`phase: 'commentary' | 'final_answer'`. These are public assistant messages,
separate from reasoning blocks and their opaque replay state. The SDK does not
infer phases from words, tool calls, or a model name.

`selectAssistantText(parts)` joins explicit `final_answer` items with two
newlines when any are present. Otherwise it joins all supplied items. It never
deduplicates equal strings: two explicitly final items remain two items.
Commentary alone keeps its original phase; it does not establish completion.
The message and run stop reasons still distinguish cancellation, truncation,
tool use and completion.

## Provider and event contract

- `StreamChunk.delta.textPart` optionally identifies the item for that content
  fragment. Fragments for a contiguous item accumulate in order.
- `StreamChunk.textParts` supplies the complete ordered snapshot at settlement,
  on a chunk without `delta.content`. It replaces accumulated text items,
  including when the provider supplies phase information only at completion.
  Subsequent content is a protocol error. Providers may still supply usage.
- `ChatCompletionResponse.message.textParts` and `AssistantMessage.textParts`
  retain all items. Their `content` contains the selected answer.
- `text_delta.textPart` carries the live boundary. The durable
  `message_completed` event carries the settled `content` and `textParts`,
  including received partial items on cancellation.

Without item metadata, ordinary delta concatenation is unchanged, byte for
byte. Custom consumers displaying progress should use deltas; consumers of
the completed answer should use settled content. Raw delta concatenation can
contain commentary that is intentionally absent from the settled answer.

The query loop, `collectChatCompletion`, and bounded preparation/review
inference share the same selection. Auxiliary inference still counts all
public text against its output limit and meters full provider usage. Hiding
commentary from the selected result does not give it a separate budget.

## Shipped producer and CLI

The Codex subscription driver maps Responses message phases into this shared
SDK contract. It also retains the original native response items. Its replay
guard checks both selected content and original public text parts, together
with the existing route and tool-call checks. Tool follow-ups and reopened
CLI conversations preserve those native phases. Modifying a stored public
part invalidates native replay; stale native items must not restore edited
content.

The CLI starts a separate transcript bubble for a new streamed item ID and
uses the settled answer for turn completion. It does not hide text merely
because the provider repeated it. Other drivers continue producing ordinary
unphased text until they explicitly map their native protocol. A custom driver
that supplies phases only at settlement gets correct SDK answer selection;
the live TUI cannot retroactively split its already streamed untagged bubble.

Original parts remain in messages and durable completion events. The existing
text evidence index searches settled `content`; it does not yet independently
index commentary excluded from that content. Cross-provider conversion and
compaction may use the selected textual projection rather than native items.

The native interpretation follows OpenAI's documented
[phase and replay guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.5).
This is a wire contract, not a claim that every model or provider emits phases.
