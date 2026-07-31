---
'@namzu/sdk': minor
---

Recover from a bad tool call without spending a model round trip on it.

- `QueryParams.repairToolCall` — a last chance to fix a call the model got
  wrong, before the error reaches it. A malformed call otherwise costs a
  full round trip: the error goes back as a `tool_result`, the model
  re-reads the whole context, and issues a second inference to add a
  missing brace. The hook sees the reason (`invalid_json`,
  `schema_validation`, `unknown_tool`), the tool's JSON Schema and every
  registered tool name, and may rewrite the arguments and the tool name —
  nothing else. It is tried exactly once, a throw is caught, and declining
  is normal: the original error simply proceeds as before.
- `ToolDefinition.maxRetries` (default `0`) + `ToolResult.retryable` — a
  transient tool failure can now be retried in-loop instead of going back
  to the model to be re-decided. Strictly opt-in per tool, because the SDK
  cannot know a tool is idempotent, and only for failures the tool marked
  retryable.
- `PluginHookResult` `{action:'retry'}` finally does something. It was a
  declared variant that threw at every site that consumed it; in
  `post_tool_use` it now re-runs the tool, bounded by the same per-tool
  budget so a plugin cannot spin the executor. It remains an error in
  `pre_tool_use`, where nothing has run yet for it to mean anything.

With no repairer configured and no tool opting into retries, behavior is
unchanged.
