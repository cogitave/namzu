---
"@namzu/sdk": minor
"@namzu/cli": minor
---

Add `ToolRegistry.fork()` and `ToolRegistryForkOptions` to snapshot tool membership and availability independently for a run. Optional `deferExcept` hides currently active schemas until discovery without changing handlers, authorization or the source registry. Definitions and configuration remain shared; this is not a deep clone. Exact short/generic deferred tool names can now be discovered, and scoped prompts only recommend `search_tools` when it is available to that scope.

Add opt-in `namzu resident run|start --tool-loading deferred` to load optional tool schemas on demand for each step. The default remains `eager`; project instructions, memory recall, continuation evidence, permissions and provider-native search are unchanged. Discovery may require another model response. The internal CLI session option applies to fresh sends, not checkpoint resume.
