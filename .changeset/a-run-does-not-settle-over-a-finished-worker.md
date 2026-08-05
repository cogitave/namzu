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

**What deliberately did not change.** These exits deliver what has already
arrived; they do not WAIT for a worker still running. A hold buys the model a
turn in which to use a result, and on an exit whose answer is already decided
there is no such turn — waiting would delay a settled answer to append text the
run will not read. The bounded hold stays on the one exit that does have a turn
left.
