---
'@namzu/anthropic': minor
'@namzu/sdk': major
---

Runs report what they cost, and a cost limit that cannot be measured is refused

Every run reported `$0.00`. `calculateCost` existed and `CostInfo` was carried on
the run, the step, the checkpoint and the `token_usage_updated` event — but a
turn was only priced when the host passed `pricing` to `query()`, and no shipped
surface passed one. The accumulation branch was dead everywhere.

`runConfig.costLimitUsd` is enforced against that same total, so a host that set
a cost cap did not have one, and nothing said so.

**`@namzu/sdk` now ships a price catalogue** — `packages/sdk/src/pricing/`, a
module generated from a reviewed in-tree source table and checked in, so a cost
number is reproducible from a commit and an offline run still prices correctly.
Rates are looked up per turn against the driver and model that actually served
it. No configuration is needed to get a real number.

## What every caller sees change

**A run that reported zero now reports a real number.** If you compare, store,
bill from, or assert on `Run.costInfo.totalCost`, the value moves on the same
inputs. Nothing about your code has to change for this — but nothing warns you
either, so check anywhere a zero was being relied upon.

**A `costLimitUsd` that was inert now enforces, or refuses.** This is the change
most likely to break a working deployment, and it can do so at two moments:

- `query()` throws `invalid_config` at the start of a run when `costLimitUsd` is
  set, no `pricing` is supplied, and the configured model has no rate. Same
  config, same model, previously-completing run — now a startup failure.
- A run stops with the new `cost_unmeasurable` stop reason when a step or a
  provider-chain member swaps to a model with no rate mid-run.

To keep a run working, do one of: pass `pricing` to declare the rate yourself;
add the model to `packages/sdk/src/pricing/rates.source.json` and regenerate;
or drop `costLimitUsd` and bound the run with `tokenBudget`, which is always
measurable. Removing the limit is the honest option if the model cannot be
priced — a budget you cannot measure was never enforcing anything.

## Breaking API changes

- **`CostInfo.inputCostPer1M` and `CostInfo.outputCostPer1M` are now optional.**
  Absent means no single rate card describes the total — the run spanned two
  models, or part of it ran at no known rate. Readers that treated these as
  `number` need a `?? ` or a branch. They were previously required and reported
  whichever card was applied last, which was a claim about the whole total that
  was true of only part of it.
- **`CostInfo` gains a required `unpricedTokens: number`.** Any code that
  constructs a `CostInfo` must supply it. Zero means nothing is unaccounted for.
  This is what lets a consumer tell "this run cost nothing" from "nobody knows
  what this run cost" — previously both were `totalCost: 0`.
- **`calculateCost` and `accumulateCost` lost their trailing `cacheDiscount`
  parameter.** It defaulted to `0`, no caller in the tree ever passed it, and
  the value it produced was subtracted from the total. `cacheDiscount` is now
  computed from the rate card and *reported* rather than subtracted — it is what
  the cache reads saved against the full input rate, and the saving is already
  inside `totalCost`. Callers passing a fourth argument get a compile error;
  drop it.
- **`StopReason` gains `cost_unmeasurable`.** Exhaustive switches over
  `StopReason` will not compile until they handle it.
- **`RunPersistence.accumulateUsage` and `recordTurnUsage` take a second
  required argument** naming who served the tokens. Required so a call site
  cannot silently misattribute; pass `{ providerId, model }`.
- **`projectEmergencyToCheckpoint` no longer reports zero cost.** A dump
  preserves a real `tokenUsage` and records no cost, so the projection now
  states that those tokens are unpriced rather than that they were free.

## Also fixed

- The advisory executor reported `totalCost: 0` for an advisor with no pricing
  table — zero-as-unknown, the same defect one file over. It now reports the
  tokens as unpriced, and falls back to the catalogue before giving up.
- Cache tokens are priced. The drivers in this repository disagree about whether
  the prompt-token count already contains cache reads (two exclude them, one
  includes them), so that fact is declared per driver in the rate source and the
  arithmetic reads it. Previously cache reads were charged at the full input
  rate or not at all, depending on the driver, and `cacheDiscount` was dead.

## `@namzu/anthropic`

The driver's offline model menu moves to an exported `OFFLINE_MODEL_CATALOGUE`
so a test can read it without a client. Two of the three models it offers had no
rate in the catalogue — a lookup-key mismatch that reads as "cost unknown" and
that the generator's own regeneration check is structurally blind to. Both rates
are added and a conformance test now holds the two lists together. No behaviour
change for callers.
