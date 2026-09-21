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
| `openai`, `codex` | The vendor's listing endpoint publishes no rates; both are omitted. |
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
