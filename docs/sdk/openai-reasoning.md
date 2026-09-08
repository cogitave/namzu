---
type: Reference
title: OpenAI reasoning effort
description: Exact Astra effort menus for the API and ChatGPT subscription transports.
resource: packages/providers/openai/src/codex.ts
tags: [sdk, providers, openai, reasoning]
status: stable
---

# OpenAI reasoning effort

`@namzu/openai` exposes model-specific menus through
`reasoningEffortLevelsFor(model)`. `CodexProvider` additionally exposes the
subscription catalogue's default through `reasoningEffortDefaultFor(model)`.
Unrecognized model identifiers return `undefined`, rather than an invented menu.

For `gpt-6-astra`, the transports publish different sets:

| Provider | Effort levels | Declared default |
| --- | --- | --- |
| `CodexProvider` (ChatGPT subscription) | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | `medium` |
| `OpenAIProvider` (API key) | `low`, `medium`, `high`, `xhigh`, `max` | Not declared by this driver |

The API set follows the [official Astra model page](https://developers.openai.com/api/docs/models/gpt-6-astra),
checked on 2026-09-08. The subscription set and default were verified against the
installed Codex 0.153.4 model catalogue fetched on 2026-09-08: its `gpt-6-astra`
record declares `default_reasoning_level: medium` and the six
`supported_reasoning_levels` above. This is subscription metadata, not evidence
that the public API accepts `ultra` or that every account has Astra access.

A selected level passes through unchanged: subscription Responses requests carry
`reasoning.effort`, while API Chat Completions requests carry `reasoning_effort`.
Omitting effort leaves the backend's default in force. Neither transport accepts
`none` or `minimal` for Astra; the API additionally rejects `ultra`, before
transport. Callers previously relying on unknown-model pass-through must select
one of the declared levels or omit effort. The provider does not translate an
`ultracode` name or option into `ultra`.

The CLI's session effort menu intersects all usable fallback members. Astra
subscription alone offers six levels; a chain including the Astra API offers
five. Any usable member without an exact menu still makes session selection
unavailable. Fixing Astra's declaration does not invent capabilities for unknown
fallback models.

This declaration does not add transport features. The API-key provider still
uses Chat Completions; Astra tool calling requires Responses according to the
[official model guidance](https://developers.openai.com/api/docs/guides/latest-model).
The subscription provider already uses Responses.

Request-capture tests verify menus, rejection before transport and exact outbound
effort fields without making live model requests. They establish driver behavior,
not account access or the backend's execution strategy for a reasoning level.
