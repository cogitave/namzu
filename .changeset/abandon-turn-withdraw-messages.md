---
"@namzu/sdk": minor
"@namzu/cli": patch
---

`abandonTurn` takes a new option, `withdrawMessages`. Pass it when you give the
turn's prompt back to a person to send again (a message box restored after
"continue without this reply"): the abandoned turn then contributes no message
to the next turn's context, so the provider receives the re-sent prompt once
instead of twice. The records stay in the log; the closing `turn_failed` carries
`failure.details.messagesWithdrawn: true`, which the fold honours. Nothing
changes unless you pass it: an abandoned turn's messages stay in the context by
default. `SessionLog.abandonTurn` accepts the same option as a fourth argument;
a custom `SessionLog` that wraps another should forward it.

The CLI's `namzu/sessions/abandon-paused` passes it, which fixes Desktop's
**Continue without this reply** sending the person's message to the provider
twice.
