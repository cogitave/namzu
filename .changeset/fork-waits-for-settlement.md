---
'@namzu/cli': patch
---

Prevent `/fork` and `/compact` from reading stale conversation history after an
interrupted turn.

The terminal becomes interactive as soon as an interrupt is requested, while a
provider iterator may still be unwinding and may not yet have attached its
partial reply to the durable-write queue. History operations now distinguish
that settlement interval from UI idleness. `/fork` waits for every write already
attached to the queue before copying, and pauses new input while it takes the
snapshot.
