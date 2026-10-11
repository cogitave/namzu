---
"@namzu/cli": minor
---

`namzu/sessions/abandon-paused` accepts an optional `withdrawMessages` boolean. Absent or `true` it behaves as before: the closed turn's messages leave the history the next request carries. Send `false` when the person goes on with a different message and the closed turn's message should stay in what the provider is shown. A reloaded Desktop conversation no longer shows the stopped partial reply of a turn whose message was withdrawn. Nothing breaks for a caller that sends only the conversation.
