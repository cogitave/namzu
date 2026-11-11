---
type: Reference
title: Model prices, and what an absent one means
description: Optional per-million rates on ModelInfo, why a driver omits a rate it never learned instead of writing zero, and how a reader should render absence.
resource: packages/sdk/src/types/provider/model.ts
tags: [sdk, providers, pricing, cli]
---

# Model prices, and what an absent one means

`ModelInfo.inputPrice` and `ModelInfo.outputPrice` are USD per million tokens,
and both are **optional**. An absent field means the driver does not know the
rate. A rate of `0` means the model is free. Those are different answers and a
consumer must keep them apart.

## Why zero was not good enough

A price of zero is not "I do not know". It is a billing fact — it says the model
costs nothing — and it reaches a consumer as a quote. A total sums it, a menu
prints `(free)`, and an operator believes both. Six drivers wrote `0` wherever
the vendor listing carried no rate, because the type required a number and there
was nothing else to write. On four of them that made every paid model on the
model menu look free.

This is the defect `9d6c482c` removed from `contextWindow`, in the field where a
wrong value is money rather than a compaction pass. The distinction was already
the house rule one level down: `resolveModelPricing` returns `undefined` for a
rate nobody has, and `{ inputCostPer1M: 0, outputCostPer1M: 0 }` for a driver
that genuinely bills nothing. Its own documentation says a caller that flattens
the two reproduces the defect the pricing module exists to remove. `ModelInfo`
carried the flattened version to every consumer that never reached that module.

## What each driver does

A driver that knows a rate writes it. A driver that does not, omits the field.

| Driver | Rates it publishes |
| --- | --- |
| `anthropic` | The bundled offline catalogue carries its published prices. The live `models.list` listing carries none, so it omits them. |
| `openai`, `codex` | The vendor's listing endpoint publishes no rates; both are omitted. In the SDK's table, `gpt-6-astra` has no row on purpose: the vendor prices it by input length (a higher rate above 272,000 input tokens), and one rate per model would be wrong for part of its requests, so its cost reports unknown. |
| `deepseek` | Omitted. |
| `google` | A two-row table prices `gemini-2.5-flash` and `gemini-2.5-pro`. Every other model the API returns is unpriced. |
| `openrouter` | The vendor's own `pricing` block. A model priced `"0"` is free and still reports `0`; a model with no pricing block is unpriced. |
| `bedrock` | A reviewed offline catalogue with real per-model list prices. |
| `ollama`, `lmstudio` | `0` for every model, always. A local server bills per token never. |
| `zen` | The pinned catalogue, whose generator refuses any model the source neither prices nor names free. |
| `http` | Lists nothing. |

`ollama` and `lmstudio` are the case the whole distinction protects: their `0`
is the one answer known for every model that could ever appear, and
`packages/sdk/src/pricing/rates.source.json` records the same claim as
`unmetered: true`. Such a driver "is priced at zero, which is KNOWN-free and
therefore distinct from unknown".

## Fast mode

A call served in fast mode costs a published multiple of every rate on its
card. `ModelPricing.fastMultiplier` carries it (`fastMultiplier` in
`rates.source.json`; 2 on `claude-opus-5-5`, `claude-fable-5-2`,
`claude-mythos-5-2`, `claude-opus-5` and `claude-opus-4-8`) and applies to input,
output and cache tokens alike. A driver reports the speed that served the call as
`TokenUsage.speed`. A fast call on a card with no multiplier is counted as
unpriced, never charged at the standard rate, so `costLimitUsd` refuses rather
than under-counts.

## Hosted web searches and service tiers

A hosted web search is billed per request, on top of tokens.
`ModelPricing.webSearchCostPer1000` carries the price (`webSearchPer1000` on a
vendor in `rates.source.json`, copied onto each of its rows; $10 for Anthropic) and
`TokenUsage.webSearchRequests` carries the count, which is summed across calls. Fast
mode does not multiply it. A card without the field leaves searches out of the total,
as before.

A driver also reports `TokenUsage.serviceTier` and `TokenUsage.inferenceGeo` when the
provider says them. Only the `standard` tier (or none reported) is priced from the
card: the vendor publishes no per-token price for `priority` or `batch`, so tokens
served on either are counted as unpriced instead of at the standard rate.

## How a reader should render it

Three answers, three renderings, and the third is the one that used to be
missing:

- rates published — print them;
- a known zero — `Free`;
- nothing published — `unknown`.

A reader that prints `$0.00` for the third has turned an absence into a quote,
which is the same mistake as the one the drivers were making, moved one layer
up. The CLI's model picker marks a row `(free)` only when both rates are present
and both are `0`, and says nothing otherwise; the catalogue block under
`agent_models` prints `Price unknown` for absence.

For cost estimation, nothing on this path is used. `resolveModelPricing` reads
the versioned rate card in `packages/sdk/src/pricing/`, not a driver's listing,
so a turn's cost is unaffected by what a menu displays.

## Whole prompt size

`TokenUsage.promptTokens` is what the driver counts as input, and drivers
disagree: some include cached tokens, Anthropic and Bedrock (and the HTTP
driver's Anthropic dialect) report only what follows the last cache breakpoint. `TokenUsage.fullPromptTokens` is the whole
prompt of one call, cache reads and writes included, set by a driver that keeps
cache apart; `promptSizeOf(usage)` returns it, or `promptTokens` when it is
absent. It is a per-call fact, never summed. The context size the compaction
trigger and the context meter read, and the input-token attribute on each
model call's span (streamed or not), use it; the turn's root span and the
budget log line keep the cumulative `promptTokens`, a sum of calls that
`fullPromptTokens` is deliberately not part of; cost still reads `promptTokens`, `cachedTokens` and `cacheWriteTokens`
separately through the rate card's `promptIncludesCacheReads`.
