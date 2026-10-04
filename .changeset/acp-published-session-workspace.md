---
"@namzu/sdk": minor
---

Add the read-only `ACPServer.getSessionCwd(sessionId)` lookup for the exact
workspace of a session published on the current connection. Reserved loads,
unknown identities and stopped servers return `undefined`. Hosts can authorize
new-session model preparation before the first durable turn without accepting
an arbitrary client-provided session ID. Folder trust and durable/Pal ownership
checks remain the host's responsibility.
