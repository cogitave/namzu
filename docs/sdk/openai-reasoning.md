---
type: Reference
title: OpenAI reasoning effort
description: Model-catalogue reasoning menus and defaults for ChatGPT subscription sessions and API transport differences.
resource: packages/providers/openai/src/codex.ts
tags: [sdk, providers, openai, reasoning]
status: stable
---

# OpenAI reasoning effort

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
The provider does not translate an `ultracode` name or option into `ultra`.

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
