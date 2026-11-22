---
type: Reference
title: Fast mode on OpenAI models
description: How speed 'fast' and 'ultrafast' reach the OpenAI API and the Codex subscription, which models admit each tier, what is refused before any request, what a response's service tier means, and what each tier costs.
resource: packages/providers/openai/src/fast-mode.ts
tags: [sdk, providers, openai, pricing, cli]
---

# Fast mode on OpenAI models

`ChatCompletionParams.speed` (and `turnConfig.speed` for a turn) asks a driver
for a premium low-latency tier. `'standard'` and an absent value are the same
request and send nothing. The OpenAI package honours `'fast'` on both of its
transports and `'ultrafast'` on one; a driver or model without the tier
**refuses** it before any request, so fast means fast or an error, never a
reply served slowly while the caller believes otherwise.

`InferenceSpeed` is `'standard' | 'fast' | 'ultrafast'`. A `switch` over it that
must be exhaustive needs an `'ultrafast'` case.

## Two routes, two kinds of evidence

| | API key (`openai`, Chat Completions) | Codex subscription (`codex`, Responses) |
| --- | --- | --- |
| `fast` on the wire | `service_tier: "priority"` | `service_tier: "priority"` and the header `x-codex-routing-hint: model=<model>;tier=priority` |
| `ultrafast` | refused (Chat Completions has no such value) | `service_tier: "ultrafast"` and the header with `tier=ultrafast` |
| Which models | a table of exact model ids in `fast-mode.ts` | the tiers the account's own model listing offers for the model |
| What it costs | a multiple of every rate, per model | more of the plan allowance; not billed per token |
| Endpoint | OpenAI's own host only | the subscription backend |

The API table is `OPENAI_FAST_TABLE`: `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`,
`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-6-sol`, `gpt-6-luna`,
`gpt-6-astra`, `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6.2-sol` and `gpt-6.2-astra`
(a dated snapshot id counts as its model). It is a table and not a version
floor because OpenAI ids do not follow one grammar, and it was read from the
vendor's pricing page on 2026-11-22; a model absent from it is refused until a
one-line change, which is cheaper than sending a tier a model rejects. The
multiple is per model: 2 on all of them except `gpt-5.5`, which is 2.5.

The subscription route has no model list in code. `CodexProvider.listModels`
reads `service_tiers` (objects with an `id`) and the older
`additional_speed_tiers` (strings) from each model, maps `priority` or `fast` to
`'fast'` and `ultrafast` to `'ultrafast'`, ignores everything else, and publishes
the result as `ModelInfo.speedTiers` and `LLMProvider.speedTiersFor(model)`.
`undefined` means the listing has not answered; once it has, a model it does not
carry offers none. The listing is kept per account and endpoint for the life of
the process, so a provider rebuilt around a refreshed token still honours an
advertised tier without asking again. No model has a default tier, so a request without `speed`
runs at standard speed.

## Refused before transport

The verdict is one pure function, `resolveFastMode` (exported as
`resolveFastModeVerdict`), and the request path and any caller deciding whether
to offer the mode both use it. A refusal is a `bad_request`
`ProviderRequestError` with `providerCode: 'fast_mode_unsupported'` and a
reason in plain words:

- a model not in the table (the reason lists the table's models),
- a base URL whose host is not `api.openai.com` (a gateway may drop the field or
  bill differently),
- `ultrafast` on an API key,
- on the subscription, a tier the account's listing does not offer for the
  model, or any tier before the listing has answered.

`speed` is a per-turn setting, so a turn that falls back to, or routes a
sub-agent to, a model without the tier fails with the same error instead of
quietly running at standard speed. Drivers other than Anthropic and OpenAI do
not read `speed` yet.

## What comes back, and what it costs

A response's `service_tier` is read per call and never summed:

| Served tier | `TokenUsage` |
| --- | --- |
| `priority` or `fast` | `speed: 'fast'` (and `serviceTier` is left unset, because the SDK reads `serviceTier: 'priority'` as "unpriced") |
| `ultrafast` | `speed: 'ultrafast'` |
| `default` or `auto` | standard: a request downgraded under load bills at the standard rate |
| `flex` or `scale` | `serviceTier` carries the value |
| none reported | the speed that was asked for, so cost is never under-reported |

The SDK prices a `'fast'` call at `ModelPricing.fastMultiplier` (see
[Model prices](model-prices.md#fast-mode)); the catalogue carries it for the six
priced OpenAI models. `'ultrafast'` has no published per-token price and is
counted as unpriced, so `costLimitUsd` refuses rather than under-counts. Calls
served on `flex` or `scale` are unpriced for the same reason. The `codex`
provider is not a catalogue vendor, so subscription calls stay unpriced.

The plan allowance multiples the terminal quotes (`PLAN_MULTIPLIER`) come from
the vendor's Codex pricing page, read on 2026-11-22, and exist only for the
models it states them for: fast is 2 on `gpt-6.2-sol` and `gpt-6.2-astra` and
2.5 on `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-astra`, `gpt-6-sol` and
`gpt-6-luna`; ultrafast is 6 on `gpt-6.2-sol` and `gpt-6.2-astra` and 8 on
`gpt-6-astra` and `gpt-6.1-sol`. Ultrafast carries a promotion until
2027-02-28, so the table holds the figure after it and a message never
understates. Any other model has no stated figure and the terminal gives none.

## In the terminal

`/fast`, `/ultrafast`, `--fast` and the saved
`fast` setting are described in [Slash commands](../cli/slash-commands.md) and
[Launch flags](../cli/launch-flags.md). `--fast` and the saved setting mean the
fast tier; ultrafast is never saved and has no launch flag. Each command is listed in the
command menu only while the selected model offers its tier (typed anyway, it
answers with the reason), and `/help` always lists both.
