---
"@namzu/sdk": minor
---

Add optional `QueryParams.maxToolCalls`, a cumulative per-run admission limit.
An oversized direct tool batch is refused before any of its calls executes;
nested dispatches and retry attempts consume additional slots. Zero disables new
tool calls, while an omitted limit keeps existing unlimited behavior.

Reservations are persisted as internal `tool_calls_admitted` run events and
survive compaction and restart. Supply the limit again when resuming the same
run. Completed recovered calls are not charged again; unfinished replay attempts
reserve new slots without refunding uncertain earlier reservations. Invalid or
unavailable recovery evidence refuses execution. This is a per-run policy, not
a shared budget across independent delegated runs.
