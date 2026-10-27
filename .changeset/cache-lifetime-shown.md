---
'@namzu/cli': minor
---

`/context` now shows the prompt cache lifetime in use (`Prompt cache lifetime: 5 minutes`, or `1 hour` when `compaction.promptCacheTtl` is `1h`) under the legend, for a provider that lets it be chosen. `namzu doctor` has a new `providers.cache-lifetime` row that reports the lifetime and, with the five-minute default, suggests `1h` for long sessions or frequent pauses of more than five minutes. The row is a pass or a skip, never a warning, and nothing changes unless you set the key.
