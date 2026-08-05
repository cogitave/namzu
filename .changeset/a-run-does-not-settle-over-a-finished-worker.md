---
'@namzu/sdk': minor
---

A run that ends any way other than a plain final answer no longer throws away a finished worker's output

The iteration loop consulted its completion inbox at exactly one place: the
branch where the model stops calling tools and answers. It leaves by eight other
routes, and three of them are ordinary ways for a run to END — a tool the author
marked `terminal`, a captured `structured_output`, and the host's `stopWhen`.
A background or abandoned worker that finished while any of those was deciding
had its result dropped: the gateway held it, the run closed, nothing read it.
Measured before the fix — terminal-tool exit and `stopWhen` exit both delivered
nothing; the final-answer exit delivered in 44 ms.

Delivery now happens in a `finally` around the loop, so it does not depend on
each exit remembering — including the two `return`s and a generator abandoned by
its consumer, which no post-loop statement reaches.

**What you may observe.** On those exits `Run.messages` can now end with a
`task-notification` user message after the assistant's last message. The answer
is on `Run.result`, as before. If you were reading the answer off the last
element of `Run.messages`, that assumption was already unsafe whenever a
notification landed mid-run; it is now unsafe in three more places.

**Which exits wait, and which only deliver.** A hold buys the model a turn in
which to use a result, so it is only worth paying where a turn can still
happen. A terminal tool and a captured `structured_output` have decided the
answer, so those deliver what arrived and stop. `stopWhen` is a programmable
halt that says nothing about whether the answer is complete, so it now HOLDS
like the ordinary final-answer exit — a precedence rule chosen here, not
something `stopWhen` implies — and costs exactly one extra turn, after which
the predicate fires again with nothing pending.

One observable consequence of that extra turn: `stopWhen` is consulted only
after a tool batch, so if the extra turn is prose the run ends by the ordinary
route and reports `stopReason: 'end_turn'` rather than `'stop_condition'`. The
stop still happened; the reason describes how the final turn ended.

A run that ends with a worker still running now says so on
`Run.abandonedTaskIds` rather than leaving the impression the result arrived.
