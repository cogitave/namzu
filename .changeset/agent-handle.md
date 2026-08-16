---
'@namzu/sdk': minor
---

`ReactiveAgentConfig` gains `steering`, and a host can now hold an
`AgentHandle` between runs.

Steering was declared only on `SupervisorAgentConfig` and forwarded only by
`SupervisorAgent` — so the archetype most hosts actually run could not be
steered at all. That is the same defect the file's own comment says it has
been corrected for twice: a capability the kernel honours in `drainQuery`
and not on the surface hosts construct is a capability nobody can reach.

`createAgentHandle` gives a host two delivery targets with stated lifetimes
and no silent third state. `steer` reaches the run happening now; it THROWS
on an idle handle rather than accepting into a queue nothing will read, and
points at the alternative. Quietly rerouting would be a host asking to
redirect what is running and getting a message delivered minutes later to a
different run — worse than an error, because nothing says it happened.

`queueForNextRun` persists onto the Topic's state record and is consumed by
the next run on that topic: prepended to its FIRST request rather than
arriving a turn late, and cleared in the same compare-and-set write that
reads it. A queue read and cleared separately re-delivers on a crash
between the two, and "start with this" arriving twice is a different
instruction from the one that was left.

The handle's status type is `AgentHandleStatus`, not `AgentStatus` — that
name belongs to a deprecated alias mid-removal, and reusing it would
silently change what a consumer's type MEANS rather than failing their
build, which is the one outcome a deprecation window exists to avoid.

`status` reads a live predicate rather than a stored flag, because a stored
one is only as current as whoever remembered to update it.
