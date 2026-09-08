---
"@namzu/openai": major
---

Discover ChatGPT subscription reasoning menus and defaults from each model's
actual catalogue metadata instead of a fixed model-name allowlist. `listModels()`
returns `ModelInfo.reasoningEffortLevels` and `reasoningEffortDefault` when valid,
and refreshes the metadata used by capability methods and request admission.
New model names with valid catalogue metadata work without driver changes.

Hosts must call `listModels()` (or `probeCredential()`) before reading subscription
menus: previously familiar model names had hardcoded levels and defaults before
any discovery; now unknown metadata remains undefined. Each successful refresh
replaces the snapshot. Missing or invalid metadata clears an old profile; failed
or cancelled refreshes retain the last successful snapshot. Explicit effort with
unknown metadata continues to reach the backend unchanged.

The API transport separately recognizes `gpt-6-astra` and rejects none, minimal,
and ultra before transport, where this formerly unknown name passed them through.
Choose low, medium, high, xhigh or max, or omit effort to retain the backend default.
Subscription catalogue levels do not imply API support or introduce an ultracode
alias.
