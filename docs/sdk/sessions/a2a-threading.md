---
title: A2A Context
description: A2A's contextId is a Project. What this page used to say, why it was wrong, and what to do instead.
last_updated: 2026-08-07
status: current
related_packages: ["@namzu/sdk"]
---

# A2A Context

**A2A's `contextId` is a namzu Project.** One line, and it is the only structural fact on this page.

```ts
// bridge/a2a/task.ts — outbound
contextId: run.project_id ?? undefined

// bridge/a2a/task.ts — inbound
projectId: params.contextId
```

Both directions, pinned by `bridge/a2a/__tests__/project-is-the-a2a-context.test.ts`. `ThreadId` appears nowhere in the A2A bridge.

## 1. What this page used to say

Until now this page opened with "A2A connections attach at the Thread level, not the Project level" and presented that as the reason the Thread layer is first-class. It was the single load-bearing justification for a whole hierarchy level.

The code never did it. The binding above has always read `project_id`, and no version of the bridge has ever referenced a Thread.

The claim survived because nothing asserted the actual binding — a doc page and a set of comments agreed with each other while the code disagreed with both. That is why the assertion now exists as a test rather than as another sentence: an unasserted invariant is a belief, and this page was made of beliefs.

## 2. What a peer actually gets

An A2A peer that receives a `contextId` from namzu holds a Project id, and may send it back to run under that Project.

- **Everything scoped to the Project is in scope for that peer.** The delegation caps, the shared stores, the retention policy and the on-disk root are all Project-level, so a peer holding a context holds the whole workspace rather than a slice of it.
- **There is no finer A2A boundary today.** If one peer should see part of a workspace and not the rest, give it a separate Project. The Thread layer was supposed to be that boundary and never became one.
- **`contextId` is absent, not empty, for a run with no project.** A peer can tell "no context" from "a context named nothing".

## 3. Context expiry

Archival is namzu's context-expiry policy, and it is surfaced as an explicit rejection when work is submitted rather than as silence. A peer that sends a `contextId` for an expired context gets a refusal it can act on, not a task that quietly does nothing — the fail-closed shape the rest of the SDK uses, where the default is refusal and the policy names the conditions under which work is admitted.

> **Being fixed separately, and worth knowing now.** Archival stops new sessions and does not stop runs already under way: `runtime/query` never consults the session store, so nothing marks a session active and the archival guard reads a field nobody maintains. Until that lands, read "archived" as "no new work admitted", not as "everything has stopped".

## 4. Thread's removal is proposed, not underway

**Thread is live. Nothing about it has been removed or deprecated.** `runAgent`
mints a `thd_` id on every run it is not given one for
(`agents/runAgent.ts:193`), `ThreadId` is an exported branded type, and no
declaration on the Thread surface carries an `@deprecated` tag. If you are
reading this to find out what shipped, the answer is: the layer is exactly where
it was.

What follows is a **proposal** and the argument for it, recorded here so the next
reader does not have to reconstruct it. It is not a migration in progress and
nothing has been staged.

The case for removing it: the layer owns no message stream, no derived status, no participant set, no policy, and no segment of the on-disk layout (`projects/{prj}/sessions/{ses}/runs/{run}`) — and its one stated justification is the A2A claim this page has just retracted.

If it were carried out, the replacements would be these. Read the right-hand
column as "what to prefer in new code", not as "what you must migrate to" —
nothing on the left has been withdrawn:

| Rather than building new work on | Prefer |
| --- | --- |
| `ThreadId` as an A2A attach point | `ProjectId` — which is what the bridge already used |
| `ThreadManager.archive` for context expiry | Project-scoped archival |
| `listSessions(threadId, …)` | `listSessionsByProject`, plus a `threadId` filter |
| `Thread` as a grouping label | `Session.threadId`, which survives as an optional **queryable** grouping key |

Under the proposal `ThreadId` itself would not go away. It would stay as an optional branded key on `Session` with a filter on listing — grouping without an entity, which is the shape other harnesses use for the same job. What would go is the container, the store, the manager, and the lifecycle.

Were it adopted, it would be staged: deprecations with named replacements first, the removal in a later major. **None of that has begun** — there is no deprecation on any Thread declaration today. Nothing here requires action beyond not building anything new on `Thread`.

## Related

- [Sessions, Threads, Workspaces, and Retention](./README.md) — the hierarchy overview.
- [Run Identities](../runtime/identities.md) — the ids that travel with a run.
