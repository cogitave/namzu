---
'@namzu/sdk': major
---

`drainQuery` no longer accepts `launchedTasks`, a map nothing ever read.

`SupervisorAgent` created a `Map<TaskId, LaunchedTaskMeta>`, filled it from
`onTaskLaunched`, and threaded it through `drainQuery` into the iteration
context. Nothing consulted it — six mentions across the repository, every one a
declaration, an assignment, or a hand-off, and no reader at any of them. It is
what remains of the old non-blocking delegation flow, whose consumer was removed
when `create_task` became blocking.

For a host the field was inert in both directions: nothing writes a
host-supplied map, so passing one did nothing and reading it back gave an empty
map. Removed straight out rather than deprecated, on the rule that a deprecation
window exists so working code can migrate and there is no working code to
migrate off a field with no producer and no reader.

**What stays.** `onTaskLaunched` on the coordinator tool options, and the meta it
carries. The `Agent` tool still calls it, so it remains a real seam for a host
that builds coordinator tools directly and wants to observe launches. What went
was the accumulator, not the signal.

**Breaking:** `launchedTasks` is gone from `drainQuery`'s parameters, and
`LaunchedTaskMeta` is no longer exported from the iteration context module. If
you passed either, delete the argument — it was not doing anything. To observe
launches, pass `onTaskLaunched` to `buildCoordinatorTools`.
