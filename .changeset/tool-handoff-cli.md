---
'@namzu/cli': minor
---

Handles a tool's request for a person (`ToolResult.handoff`, see `@namzu/sdk`). The `paused` `AgentEvent` gains `handoff`. The terminal shows the reason with `press Enter to continue · Esc to stop`: Enter resumes the turn and Esc abandons it. `namzu exec` prints `Turn paused — needs you: <reason>`. A scheduled run paused this way records `awaiting-approval` with the reason (`reason` and the new `handoff.reason` in its run result), and its notification says `needs you: <reason>`. `namzu resume <session-id>` and `/resume` offer Continue or Abandon for such a run instead of a permission screen. Nothing to change on your side.
