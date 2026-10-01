---
"@namzu/cli": minor
---

Send an operator message directly from a selected child transcript while preserving the parent's draft. Running children accept bounded input at the next valid request boundary; finished shared-workspace children retained by this process can receive a new task in the same conversation with current permissions, credentials and budget. Saved-only and isolated-workspace continuation is refused. The parent receives host-attributed assignment notices and explicitly framed child results; a durable observation journal preserves unacknowledged reports across restart without restoring execution authority.

Only a parent response ending with `end_turn` acknowledges its captured observation snapshot. Timeouts and other unsuccessful stops keep notices pending, including stops before a model request; observations arriving after that snapshot are not acknowledged accidentally.
