---
"@namzu/cli": patch
---

The `workflow` tool now reports a script that fails before it starts any agent as a failed tool call with the located error (line, column, source line), instead of "started in the background" followed by a separate failure message and a dead `0/0` row on the rail; a script that finishes without an agent returns its result in the call. `wait_for_task` given a workflow run id now says in a sentence that a workflow run is not a task and that its end arrives as one message, instead of a UUID format error. Nothing for callers to change.
