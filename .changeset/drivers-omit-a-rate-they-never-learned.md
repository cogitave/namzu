---
'@namzu/anthropic': major
'@namzu/openai': major
'@namzu/deepseek': major
'@namzu/google': major
'@namzu/openrouter': major
---

`listModels()` omits `inputPrice` and `outputPrice` for a model this driver has no rate for, instead of reporting the rate as `0`.

The returned `ModelInfo[]` is the published signature that moved: both fields are optional on it now, so read them as `number | undefined`. Their runtime values changed too, and that half is not caught by a type — a key that used to be present is now absent, and code that defaulted it with `?? 0` will keep doing exactly what this release stopped doing for you.

What each driver does now:

- **`@namzu/anthropic`** — the live listing from `models.list` carries no rates, so it omits both. The bundled offline catalogue still carries its real published prices, unchanged.
- **`@namzu/openai`** — `client.models.list` publishes no rates, so both are omitted. `codex` likewise.
- **`@namzu/deepseek`** — the account listing and the bundled known-model list are unrated here, so both are omitted.
- **`@namzu/google`** — the two-row price table still prices `gemini-2.5-flash` and `gemini-2.5-pro`; every other model the API returns is now unpriced rather than free.
- **`@namzu/openrouter`** — a model whose listing carries no `pricing` block is unpriced. A model the vendor prices at `"0"` is still free and still reports `0`, which is the distinction this release is about.

An absent rate means unknown, and a consumer that shows one should say so rather than `$0.00`. `@namzu/sdk`'s `ModelInfo.inputPrice` carries the reasoning.
