---
'@namzu/sdk': major
---

`ModelInfo.contextWindow` and `ModelInfo.maxOutputTokens` are now optional. Four drivers filled them with `0` where the vendor listing carries no value, and they omit the field instead.

Zero is not a window. It is "I do not know" written as a number, and it reaches a consumer as a measurement of a model that can hold nothing: divide by it and get `Infinity`, compare against it and conclude every prompt is too long. Absent says the same thing honestly, and lets a consumer fall back to its own table instead of trusting a value that was never known.

**What breaks:** code reading `model.contextWindow` as a `number` must handle `undefined`. That is the point — the value was already absent in fact, and the type was asserting otherwise. Values that are genuinely known (the offline catalogues, and OpenRouter's real `context_length` mapping) are unchanged.
