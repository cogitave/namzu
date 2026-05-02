---
'@namzu/sdk': major
---

fix(sdk)!: drop plan-task lifecycle from `buildAgentTool`

`buildAgentTool` used to auto-create a plan task in the supplied
`taskStore` and flip it to `'in_progress'` before invoking the
subagent. On success it flipped to `'completed'`, but on failure
the plan task was left stuck in `'in_progress'` forever — the
`TaskStatus` enum has no `'failed'` value to transition to, so
there was no honest way to close it from inside the tool.

Removed `taskStore` and `runId` from `AgentToolOptions` entirely.
The `Agent` tool's job is "invoke a subagent and return the
result"; plan-task tracking is the parent's responsibility via
`TaskCreate` / `TaskUpdate`, where the host owns the status
semantics. This avoids the leak class entirely instead of
patching it.

Breaking change for any consumer that was relying on the auto-
plan-task behaviour. Migrate by creating the plan task on the
host side before calling `Agent`, and updating it on the host
side once the tool result is in hand.
