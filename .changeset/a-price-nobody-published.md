---
'@namzu/sdk': major
---

`ModelInfo.inputPrice` and `ModelInfo.outputPrice` are now optional. Six drivers wrote `0` wherever the vendor listing carries no rate; they omit the field instead.

A price of zero is not "I do not know" — it is a billing fact. It says the model is free, and it reaches every consumer as a quote: a menu prints `(free)`, a total reports the model as costing nothing, and an operator believes both. The drivers had no way to say anything else, because the type required a number.

This is the defect `9d6c482c` removed from `contextWindow`, in the field where a wrong value is money rather than a compaction pass. The distinction was already the house rule one level down: `resolveModelPricing` returns `undefined` for a rate nobody has and `{ inputCostPer1M: 0, outputCostPer1M: 0 }` for a driver that genuinely bills nothing, and its own docblock says a caller that flattens the two reproduces the defect the module exists to remove. `ModelInfo` carried the flattened version to every consumer that never reached that module.

**What breaks.** Code reading `model.inputPrice` or `model.outputPrice` as a `number` must handle `undefined`. That is the point — the value was already absent in fact, and the type was asserting otherwise. Treat `undefined` as unknown rather than as free: a caller that renders a price should say "unknown" rather than `$0.00`, and only `0` means the model is free.

**What does not change.** A driver that knows a rate of zero still writes `0`. `ollama` and `lmstudio` bill nothing by construction, and the Zen catalogue's free tier is priced from a source that names those models free. Values that were genuinely known are untouched.
