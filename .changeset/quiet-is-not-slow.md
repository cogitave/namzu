---
'@namzu/sdk': minor
---

a delegated worker is bounded by how long it has been quiet, not only by how long it has run

`DELEGATION_TIMEOUT_MS` gave the supervisor an hour to wait, which fixed the
two-minute deadline that made the blocking path structurally unreachable. An
hour of wall clock is still the wrong quantity to measure: it says nothing
about whether the worker is doing anything.

One number cannot answer both questions. It has to be generous enough for a
child doing real work, which is exactly what makes it useless as a stall
detector — so a worker wedged in its second minute held the supervisor for
another fifty-eight, and a worker making steady progress at minute fifty-nine
was cut off for being slow rather than for being stuck.

There are two clocks now:

- **the run bound**, elapsed time, never refreshed, still an hour. For a worker
  that stays busy forever.
- **the idle bound**, time since the worker last did anything, reset on every
  progress signal. Five minutes, overridable with `NAMZU_DELEGATION_IDLE_MS`.
  For a worker that stopped.

Whichever fires first ends the wait, and **the result says which** — "it went
quiet" and "it ran too long" are different diagnoses that lead to different
next moves, and the message is what a model acts on.

Giving up on the wait does not cancel the worker. The child keeps going and its
completion still arrives as a task notification, because a wait that ran out is
a statement about the waiter, not about the work. Losing an eight-minute
worker's output because a clock expired is the shape of the bug this whole area
has been unpicking.

**`TaskGateway.onTaskProgress` is new and OPTIONAL.** The idle bound needs a
signal that a task did something, and only a gateway can see it. It is optional
because hosts implement `TaskGateway` and not all of them can observe their
children — a gateway without it is bounded by the wall clock alone, exactly as
before. That degradation is deliberately visible rather than silent: the
timeout result carries `idleBoundArmed`, and the message says outright that
this gateway cannot tell a busy worker from a stuck one.
