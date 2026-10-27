---
'@namzu/sdk': minor
---

A delegate can now continue the caller's conversation. `ToolContext.conversation` (set by `query()` on every tool call) reads the messages the model is shown and the assembled system prompt, and `CreateTaskOptions.inheritedMessages` places messages before the child's prompt. Both are optional and additive: a host that sets neither sees no change, and a tool that needs the conversation should refuse when `context.conversation` is absent. The default sub-agent doctrine now says a fresh sub-agent starts with none of the caller's context and describes the fork type for hosts that offer it.
