---
"@namzu/sdk": major
"@namzu/cli": patch
---

The default point at which older history is summarised changes. `compactionConfig.triggerThreshold` no longer defaults to `0.7`; it is optional, and when absent the kernel derives the trigger as the reference terminal does: the window, less room for the reply (the model's output cap, at most 20,000 tokens), less a 13,000-token buffer. That is 167,000 tokens (83.5%) of a 200,000-token window and 967,000 (96.7%) of a 1,000,000-token one, and never less than half the window. A host with long contexts compacts later than before, so a conversation keeps more of its history and runs closer to the provider's limit.

The type of `triggerThreshold` is now `number | undefined` (it was `number` after parsing), so code that reads it from a parsed `CompactionConfig` must handle `undefined`; `resolveTriggerThreshold(configured, windowTokens, maxOutputTokens?)` is exported and returns the fraction actually used.

To keep the earlier behaviour, pass `triggerThreshold: 0.7` in `compactionConfig`. An explicit value is used exactly as before.

The CLI no longer sets 0.7 and takes the derived trigger; its footer meter and `/context details` read the same function.
