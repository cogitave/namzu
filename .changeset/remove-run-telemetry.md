---
"@namzu/telemetry": major
---

Requires `@namzu/sdk >=44.0.0` (was `>=1.0.0`), and the span, metric and
attribute names the kernel emits changed with it. Dashboards, alerts and
queries that filter on the old names stop matching.

- `agentRunSpanName` (from `@namzu/telemetry/attributes`) is
  `agentTurnSpanName`, and the span it names is `namzu.agent.turn <name>`
  (was `namzu.agent.run <name>`).
- The histogram `namzu.run.duration` is `namzu.turn.duration`.
- The attributes `namzu.run.id`, `namzu.run.status` and `namzu.run.parent_id`
  (`NAMZU.RUN_ID`, `NAMZU.RUN_STATUS`, `NAMZU.RUN_PARENT_ID`) are removed.
  Spans carry `namzu.turn.id` (`NAMZU.TURN_ID`), `namzu.turn.status`
  (`NAMZU.TURN_STATUS`) and, on a child session, `namzu.session.parent_id`
  (`NAMZU.SESSION_PARENT_ID`).
- Every span the kernel opens for a turn — the turn's root span, each
  `namzu.agent.iteration` span, each `chat <model>` span and each
  `namzu.tool.execute` span — now carries `gen_ai.conversation.id`
  (`GENAI.CONVERSATION_ID`), set to the Namzu session id, and `namzu.turn.id`,
  so one conversation's turns group together and any span finds its turn. A
  tool a host calls directly, outside a turn, gets them only when its
  `ToolContext` names a session and a turn.
- Session export forwards the SDK's renamed events: `turn_*` instead of
  `run_*` and `child_session_*` instead of `subsession_*`, each with
  `sessionId` and, inside a turn, `turnId` instead of `runId`.

What to do: upgrade both packages together, then replace `namzu.run.*` with
`namzu.turn.*` (and `namzu.run.parent_id` with `namzu.session.parent_id`) in
every dashboard and query.
