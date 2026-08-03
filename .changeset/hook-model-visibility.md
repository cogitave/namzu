---
'@namzu/sdk': minor
---

Show extensions the model call they fire around

`pre_llm_call` and `post_llm_call` fired directly beside the request and the reply and were handed neither — only a run id and an iteration number. An extension could observe THAT a call was happening and nothing about what it was, so a prompt audit, a redaction pass, or a per-tenant token ledger had no way to do its job from a hook.

`PluginHookContext` now carries `request` on `pre_llm_call` (`model`, `messages`, `toolNames`, `temperature`, `maxTokens`) and `response` on `post_llm_call` (`content`, `toolNames`, `finishReason`, `usage`). Both are projections rather than the wire objects, so driver-specific parameters do not become part of the plugin contract by accident, and tools appear as names because an audit asks which capabilities were offered, not what their schemas look like.

Both are read-only and frozen, and the messages are frozen copies. A hook that reshaped the request would change what every later hook sees, making the outcome depend on installation order — shaping a call stays with `prepareStep`, which has one writer by contract.
