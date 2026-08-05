---
'@namzu/sdk': patch
---

a delegated child is no longer strangled by a file-read deadline, and a closed tuple stays closed

**The deadline.** `create_task` runs an entire agent and inherited the tool
executor's generic two-minute default — the one whose own docstring says *"a
tool that legitimately runs longer declares its own `timeoutMs`"*. It did not.

Measured on real traffic: three delegated children finished in 4m21s, 5m58s and
8m04s while all three parents timed out at 120s. The children were never killed
— only the parent's wait was — so the blocking path was not occasionally missed,
it was structurally unreachable, and the supervisor was left calling
`agent_task_list` in a sleep loop because nothing else was available to it.

`DELEGATION_TIMEOUT_MS` is now one hour, exported so it is greppable, and
applied to `create_task`, `wait_for_task` and `continue_task`. An hour rather
than "a bit more than eight minutes" because a generic stopwatch is the wrong
instrument for a child that is making progress: a failure should come from what
the child is doing. A wedged child is still caught, and the run budget and
iteration ceiling both still apply above this.

**The instruction to poll was ours.** `agent_task_list` described itself as the
way to *"confirm every launched task reached `completed`"* and as *"safe to call
repeatedly"* — an order to burn a turn on a listing whose answer a blocking
`create_task` had already delivered. It now says the opposite, and points at the
cases the listing is actually for. `create_task` gained the matching clause in
the other direction: until a worker's result arrives, do not fabricate,
summarise or predict it.

**The tuple.** `toSchemaDialect` translated draft-07's `additionalItems: false`
by dropping it, on the reasoning that 2020-12 closes a tuple by default. It does
not — with `prefixItems` set and no `items`, elements past the tuple are
unconstrained — so every closed tuple was silently widened into an open one. A
schema written to forbid a third element began to allow any number. It now
emits `items: false`, which the wire accepts.
