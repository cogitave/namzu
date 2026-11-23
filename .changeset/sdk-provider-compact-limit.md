---
'@namzu/sdk': minor
---

A provider can now report the token count at which its service says compaction should start: the optional `LLMProvider.resolveAutoCompactLimit(model, signal)` and `ModelInfo.autoCompactTokenLimit`. When one is reported and the host set none of `triggerThreshold`, `autoCompactWindowTokens` or `contextWindowTokens`, the compaction trigger is `min(limit, 90% of the window)` instead of the derived trigger, so a model whose provider states a limit can now compact earlier than before; to keep the previous trigger, set `compaction.triggerThreshold`. The provider wrappers pass the new member through. No model-name row exists for the gpt-6 family: a gpt-6 model whose provider states no window falls to the 128,000-token default, as before.
