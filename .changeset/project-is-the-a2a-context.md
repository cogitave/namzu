---
'@namzu/sdk': patch
---

A2A's `contextId` is a Project, and now something says so.

No behaviour changes. `runToA2ATask` has always bound `contextId` to
`project_id` and `a2aMessageToCreateRun` has always read it back as
`projectId`; `ThreadId` appears nowhere in the A2A bridge. What changes is that
the binding is asserted in both directions, and the documentation stops
claiming the opposite.

`docs/sdk/sessions/a2a-threading.md` opened with "A2A connections attach at the
Thread level, not the Project level" and presented that as the reason the Thread
layer is first-class — the single load-bearing justification for a whole
hierarchy level. The code never did it. The claim survived because nothing
asserted the actual binding: a doc page and a set of comments agreed with each
other while the code disagreed with both.

The page now states what the bridge does, retracts what it used to say, and
carries the replacement table for the Thread removal that follows. A test pins
the binding in both directions so the next version of this cannot drift back
into prose.
