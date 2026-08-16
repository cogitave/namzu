---
'@namzu/sdk': minor
---

Three exported names now say what they operate on. Old spellings still work
and are marked `@deprecated`; they are removed in the next major.

| Old | New |
| --- | --- |
| `collect` | `collectChatCompletion` |
| `Registry` | `BaseRegistry` |
| `ContextCache` | `PromptCache` |
| `ContextCacheConfig` | `PromptCacheConfig` |
| `QueryParams.contextCache` | `QueryParams.promptCache` |

`collect` gave no hint what it collected — it drains a `StreamChunk`
iterable into a `ChatCompletionResponse`. `Registry` sat unqualified beside
seven domain-named siblings in the same barrel (`ToolRegistry`,
`AgentRegistry`, and five more), so the bare name read as the
general-purpose one when it is the base class. `ContextCache` named one
input two ways a single call apart: `new ContextCache(ContextCacheConfig)`
then `.getSystemPrompt(PromptCacheInput)`.

To migrate, change the import; nothing else moves. `PromptCacheInput` was
already correct and is unchanged.

Setting both `contextCache` and `promptCache` to different instances throws
rather than picking one, before the run starts and at no provider cost. A
caller who set both has a real disagreement about which cache to use, and
silently preferring either would run with a value they also asked not to
use. Setting both to the *same* instance is fine.
