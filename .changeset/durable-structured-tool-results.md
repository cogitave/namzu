---
'@namzu/sdk': minor
---

Add opt-in `structuredOutput.toolResultRetention: 'durable'` for tool mode.
Retain screened, post-hook JSON independently of capped tool previews, so
larger valid candidates can reach review and final structured settlement.
The default `receipt` behavior is unchanged; native mode rejects the durable
tool option.

The full JSON is an additional host-visible `tool_completed.structuredResultJson`
field and a verified completion recovery field, not provider-message content
or proof of acceptance. Guardrails, hooks, skips, cancellation and the session
record size ceiling still apply. Resume preserves execution evidence without
automatically accepting a pre-crash candidate or replaying its tool.
