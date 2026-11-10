---
'@namzu/anthropic': major
'@namzu/sdk': minor
'@namzu/cli': minor
---

Fast mode, and a larger request budget for Anthropic.

`@namzu/anthropic` (major): the default request rich-content budget on the vendor's own endpoint rises from 24 MiB to 100 MiB of base64 (the first-party Messages limit is 128 MB). A changed default is a major change: a session that kept 24 MiB of images and documents now keeps up to 100 MiB, so requests are larger and spend more input tokens. To keep the old behaviour, set `turnConfig.maxRequestRichContentBytes` to `25165824`. A driver behind another `baseURL` or with `compatibleEndpoint: true` declares nothing and keeps 24 MiB. New: `speed: 'fast'` is sent as the top-level `speed` field only to Claude Opus 5.5, Fable 5.2 and Mythos 5.2 (and later in those families) and the Opus 5 and Opus 4.8 previews, with the `fast-mode-2026-02-01` beta header added only on the previews; any other model, and Opus 4.8 from 2026-11-30, is refused before sending with `providerCode: 'fast_mode_unsupported'`, and so is a driver not on the vendor's own host (a `baseURL` other than `api.anthropic.com`, or `compatibleEndpoint: true`). New exports `supportsFastMode`, `resolveFastModeVerdict`, `FAST_MODE_BETA`; new option `AnthropicConfig.clock`.

`@namzu/sdk` (minor): `ChatCompletionParams.speed`, `TurnConfig.speed`, `AgentConfig.speed` and `TokenUsage.speed`; `ModelPricing.fastMultiplier` (2 on the five fast-capable Anthropic rows) is applied to a fast call, and a fast call on a card without one is reported as unpriced rather than at the standard rate; `ProviderCapabilities.maxRequestRichContentBytes` lets a provider declare its budget (a fallback chain takes its smallest member's). Nothing changes for a provider that declares nothing, which keeps 24 MiB; `maxRequestRichContentBytes` still overrides.

`@namzu/cli` (minor): `--fast` and `/fast [on|off]`, off by default and never saved, shown as `fast` in the footer, turned off with a message when a model change cannot keep it, and refused on a custom or compatible `ANTHROPIC_BASE_URL`. A `/model` pick made while a reply runs that cannot keep fast mode waits for the reply to end instead of applying live.
