---
'@namzu/sdk': minor
'@namzu/cli': minor
'@namzu/openai': minor
'@namzu/deepseek': minor
'@namzu/anthropic': major
---

Add the chain-aware `reasoningEffortLevelsFor(model, thinking)` provider capability while retaining `effortLevelsFor` as a deprecated compatibility member. The four capability states now distinguish a driver with no menu, an unknown model, an explicitly unsupported model, and an exact selectable set; fallback chains expose only levels every reachable member accepts.

The TUI adds session-scoped `/effort [level|default]`, sends the selection to later main-query turns, and resets it atomically when a provider/model replacement succeeds. Failed or cancelled replacements preserve the current selection.

OpenAI publishes exact known-model menus and keeps unknown compatible-endpoint models unknown. DeepSeek explicitly publishes no supported levels. Anthropic now refuses unsupported effort levels before transport instead of silently dropping them; callers upgrading Anthropic must choose a level returned by `reasoningEffortLevelsFor()` or omit `effort` to retain the provider default.
