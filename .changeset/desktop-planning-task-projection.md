---
'@namzu/cli': minor
---

Add the desktop host's read-only `namzu/tasks/list` extension and opt into negotiated `namzu/tasks/update` notifications. Restore the existing planning list from its durable session store before new work, preserving failed outcomes and deletions. Scope reads to the authorized project, session, tenant and Pal claim; exclude task descriptions, metadata and filesystem paths. Older clients continue using the existing ACP update union.
