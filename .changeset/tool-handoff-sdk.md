---
'@namzu/sdk': minor
---

A tool can now stop the turn for a person: return `handoff: { kind: 'human-required', reason, detail? }` on its `ToolResult` (new type `ToolHandoff`). The kernel commits the batch's results, writes a checkpoint and ends the segment with `turn_paused` instead of calling the model again. The event and its session-log record carry the new optional `handoff` field, and the SSE (`turn.paused`) and A2A bridges forward it. `resumeSession` continues the turn from that checkpoint as it does after a provider pause, with a model call that sees the results. In a delegated child (a turn with `parentSessionId`) the handoff fails the child's turn with a non-retryable `tool_error` naming the reason, so the parent receives a failed child result.

Nothing changes for tools that do not set the field. A consumer that switches exhaustively on `turn_paused` fields, or validates session-log records with its own strict schema, should accept `handoff`.
