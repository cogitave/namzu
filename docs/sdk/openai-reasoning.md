---
type: Reference
title: OpenAI reasoning effort
description: Model-catalogue reasoning menus and defaults for ChatGPT subscription sessions and API transport differences.
resource: packages/providers/openai/src/codex.ts
tags: [sdk, providers, openai, reasoning]
status: stable
---

# OpenAI reasoning effort

## Empty assistant history on the API wire

The API-key Chat Completions driver omits assistant entries that have neither
content nor tool calls after wire conversion. Interrupted replies or
reasoning-only turns from another provider can otherwise become invalid empty
assistant messages. This is outbound normalization, not a rewrite of the stored
conversation: original reasoning remains in history, tool-only assistant turns
and their results are preserved, and no placeholder answer or foreign private
reasoning is inserted into the request. It applies to both streaming and
non-streaming Chat Completions requests; the subscription Responses driver
retains its separate native replay rules below.

`CodexProvider.listModels(signal?)` reads the account's actual subscription model
catalogue and publishes each model's `reasoningEffortLevels` and
`reasoningEffortDefault` in its `ModelInfo`. There is no subscription model-name
allowlist. New identifiers receive menus when their catalogue rows contain valid
metadata; they do not need a driver release merely because their names are new.

The driver validates `supported_reasoning_levels[].effort` against the SDK's
reasoning vocabulary. Missing, malformed, duplicated or unknown levels leave the
exact menu undefined; filtering unknown values would misrepresent the published
menu. An explicit empty array remains a known empty menu. A
`default_reasoning_level` is exposed only when it belongs to the validated menu.
Hidden catalogue entries are not offered.

Each successful catalogue refresh replaces the provider instance's cached
metadata, including clearing profiles that disappeared or became invalid.
`reasoningEffortLevelsFor(model)` and `reasoningEffortDefaultFor(model)` read that
same snapshot, and request admission checks selected levels against it. A failed
or cancelled refresh retains the last successful snapshot. Before discovery,
capability methods return undefined, even for familiar names; hosts should await
`listModels()` before building menus. `probeCredential()` also loads the catalogue.
There is no hidden discovery request on every model turn.

A selected level passes through unchanged in subscription Responses requests as
`reasoning.effort`. Known menus reject unsupported levels before transport.
When exact metadata is unavailable, an explicit effort retains the driver's
existing pass-through behavior and the backend validates it; absence of metadata
is not a claim of support. Omitting effort leaves the backend's default in force.
The provider does not translate a mode name or option into `ultra`.

The API-key provider has a separate transport and metadata source. Its public
`/models` catalogue does not advertise subscription reasoning profiles, so its
existing model-specific capability declarations remain applicable. For example,
the [official Astra model page](https://developers.openai.com/api/docs/models/gpt-6-astra),
checked on 2026-09-08, lists `low`, `medium`, `high`, `xhigh`, and `max`. A
subscription catalogue can expose a different set; subscription `ultra` does not
prove API `ultra` support. The API driver rejects Astra `none`, `minimal`, and
`ultra`; callers previously relying on unknown-model pass-through must select a
published level or omit effort.

The CLI's session effort menu intersects all usable fallback members after
capability discovery. Any member without an exact menu still makes session
selection unavailable. Neither discovery nor intersection invents a menu for an
unknown fallback or grants account access to a model.

This metadata does not add transport features. The API-key provider still uses
Chat Completions; Astra tool calling requires Responses according to the
[official model guidance](https://developers.openai.com/api/docs/guides/latest-model).
The subscription provider already uses Responses.

Request-capture tests use previously unknown model names to verify catalogue
projection, refresh, malformed metadata, rejection before transport and exact
outbound effort fields without live model requests. They establish driver
behavior, not account access or the backend's execution strategy for a level.

## Compatible API catalogues and reasoning

The API-key Chat Completions driver also reads optional compatible-endpoint
declarations from `/models`. A field is read only where its meaning is stated;
anything else stays unknown, which a consumer treats as "ask the SDK's table" or
"do not show", never as zero.

| `ModelInfo` field | Read from, first that is present and valid |
| --- | --- |
| `contextWindow` | `context_window_tokens`, `context_window`, `context_length`, `max_model_len` (positive safe integers) |
| `maxOutputTokens` | `maximum_output_tokens`, `max_output_tokens`, `max_completion_tokens`, `top_provider.max_completion_tokens` |
| `inputModalities` | `capabilities.vision` (true: text and image, false: text), else `input_modalities`, `architecture.input_modalities`, or `modalities` on a chat model (`task` absent or `chat`); only `text`, `image` and `document` are kept |
| `supportsToolUse` | `false` only when `capabilities.tools` is `false`; otherwise true as before |
| `inputPrice`, `outputPrice` | `pricing.prompt`, `pricing.completion`, dollars per token (a number or numeric string) as dollars per million; not read when `pricing.currency` is anything but USD |
| `reasoningEffortLevels` | a valid, duplicate-free `supported_reasoning_efforts`; else `capabilities.reasoning_effort_values` together with the names in `capabilities.reasoning_effort_aliases` (the endpoint accepts them); `capabilities.reasoning_effort: false` is an empty menu; a menu listed as `null` is unknown |
| `reasoningEffortDefault` | `reasoning_effort`, kept only when it belongs to the menu |

A default output length (`default_max_output_tokens`) is not a limit, and a price
in a gateway's own credits is not a dollar price, so neither is read. The CLI
uses these model rows when discovering an unfamiliar model's effort menu, without
a model-name allowlist.

For a base URL that is not OpenAI's own API (from `baseURL` or `OPENAI_BASE_URL`),
the driver also implements `resolveContextWindow`: the window the endpoint declares
for the model decides where compaction triggers, ahead of the SDK's model-name
table, which cannot know what a gateway serves under a familiar name. A window set
in config still outranks it. The listing is requested once per driver and a
fulfilled one is kept; a failure is remembered for five minutes and a listing that
takes more than three seconds is cut short, so a model the listing does not carry,
or an endpoint without a usable listing, leaves the table to answer at the cost of
one request. OpenAI's own API declares no window, so it is not asked.

Streaming string fields `delta.reasoning_content` and `delta.reasoning` are
preserved as thinking deltas (`reasoning_content` takes precedence). This keeps
reasoning-only output cutoffs observable to the runtime. Object-valued or
encrypted reasoning fields are not treated as displayable text. These optional
fields do not change the driver's outbound history normalization described above.

## Hosted web search

The Codex subscription driver also supports opt-in `webSearch: { mode: 'live' }`
or `webSearch: { mode: 'cached' }` on completion parameters and run configuration.
See [Web search](../cli/web-search.md) for capability checks, activity events,
source retention, fallback behavior, and current driver limitations.

## Native conversation continuity

The subscription driver retains finalized Responses output, including encrypted
reasoning, messages, function calls and hosted-tool items, in the assistant
message's opaque `source.replayState`. The runtime persists this state with the
message. It is replayed only when the provider/model/fallback route, visible
content and tool calls still match the original response. Editing or compacting
that message can make the state ineligible; switching models does not send the
previous model's native items to the new model.

The subscription stream can deliver completed items through
`response.output_item.done` while leaving `response.completed.output` empty.
The driver therefore collects finalized items by output index and uses them when
the terminal snapshot is empty or absent. A populated terminal snapshot is used
as supplied, without appending duplicates. The same resolved output determines
the native replay record, tool-call finish reason and hosted citation links.
Only `response.completed` commits replay state; unfinished added items, a
disconnected stream, cancellation and failed/incomplete responses do not create
a completed replay record.

This follows the distinction between finalized items and response completion in
the [official Responses event reference](https://developers.openai.com/api/reference/resources/responses/streaming-events).
The empty terminal snapshot was observed directly on the subscription endpoint;
it is not assumed to be the behavior of every OpenAI-compatible service.
Previously discarded native items cannot be reconstructed from old plain-text
history. This correction preserves newly received items and does not promise
perfect recall or answer accuracy.
