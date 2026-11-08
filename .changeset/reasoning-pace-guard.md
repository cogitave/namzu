---
"@namzu/sdk": major
"@namzu/cli": major
---

A step that thinks too long before acting is now cut short, and a run that keeps thinking without changing anything is nudged. Both are on by default.

What changes for you: a model call that streams more than 24,000 tokens of reasoning before it makes a call is stopped, at medium, high, xhigh and max effort, and the model is told to act; the next step requires a tool call and runs at low effort where the model offers it. A reply that holds only reasoning is asked for once more, and a turn that still produces nothing now ends with a plain error instead of ending silently. After 12 steps in a row that changed nothing (a failed, read-only or task-list call changes nothing) the model is nudged, and 5 steps later the next step is an action step. The cap is a changed default, hence major. To keep the old behaviour set `reasoning: { maxTokens: 0, stall: false }` on the turn; the CLI takes `limits.maxReasoningTokens: 0`, and the CLI's default is the changed one too, hence major there as well. New: `TurnConfig.reasoning`, the `progress-nudge` runtime-context message kind (a host that switches over the kinds exhaustively adds a case) and `StepStopped` for a provider wrapper that must tell a deliberate step stop from a caller's Stop.
