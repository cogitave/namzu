---
'@namzu/cli': minor
---

The `usage` event of `namzu exec --json` gains `inputTokens`, `cacheReadTokens` and `cacheWriteTokens`, cumulative for the turn beside `totalTokens` and `outputTokens`. On a warm Anthropic cache `inputTokens` is only the uncached remainder, so a reader that wants what the model was sent adds the three. `contextTokens` now counts the whole prompt, cache included. Existing fields are unchanged.
