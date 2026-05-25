---
'@namzu/sdk': patch
'@namzu/cli': minor
---

**Sub-agents do real work, and tool tracking is keyed on the SDK's tool-use id.**

- Sub-agents now get the same tool set as the parent — builtins, memory, and clawtool's catalog (deferred, incl. web search/fetch and peer dispatch) — so a delegated research/work task can actually use tools instead of answering from memory alone.
- The transcript's live tool tracking now matches each call by the SDK's stable `toolUseId` rather than by name/order, so parallel tool calls (even same-named) are attributed correctly.
- Stronger anti-fabrication instruction for both the main agent and sub-agents: never claim to have run a tool, written a file, or produced a result without actually doing it; if a capability is unavailable, say so instead of inventing output.
- `@namzu/sdk`: the `Agent` tool's `subagent_type` is now optional when only one sub-agent is registered (defaults to it), so the model can't trip a "subagent_type required" validation error on the common single-sub-agent setup.
