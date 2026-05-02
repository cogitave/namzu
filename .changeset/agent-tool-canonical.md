---
'@namzu/sdk': minor
---

feat(sdk): canonical `Agent` tool for synchronous subagent delegation

Adds `buildAgentTool({ gateway, workingDirectory, allowedAgentIds, ... })`
that builds a single tool named `Agent` with the input shape
`{ description, prompt, subagent_type }`. This mirrors Claude Code's
training distribution verbatim (per `code.claude.com/docs/en/sub-agents`):
the parent's tool call BLOCKS on `gateway.waitForTask(handle.taskId)`,
the subagent runs in its own context window, and the subagent's final
text comes back as the tool result.

Why this matters: the existing `buildCoordinatorTools` shipped a
non-blocking `create_task` / `continue_task` / `cancel_task` trio that
returned immediately and surfaced subagent completion via a
`<task-notification>` callback. That pattern is useful for fire-and-
forget multi-task fan-out but is **not** what Claude was trained on.
Models calling the async coordinator tools waste tokens reasoning
about whether the task completed yet; with the canonical `Agent`
tool, the model just receives the result and continues. Free
alignment, no system-prompt argument needed.

Both surfaces remain available — the coordinator trio is the right
choice for genuine work-queue surfaces, the `Agent` tool is the
right choice when the host wants Claude Code parity.
