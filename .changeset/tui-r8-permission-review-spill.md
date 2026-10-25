---
'@namzu/sdk': minor
---

A tool call whose input is too large for one session-log record no longer ends the turn. The large `input` of a `tool_review_requested`, `decision_requested`, `tool_executing` or `tool_input_completed` record is now written to `tool-results/` and the record holds `{ "$spilledInput": <spill reference>, "preview": … }` in its place; a resumed turn reads the parked request's inputs back whole. A reader that walks the log itself and wants the full input of such a record reads the referenced spill (`SessionLog.readSpill`). Nothing to do for hosts that use the runtime.
