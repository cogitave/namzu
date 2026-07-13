---
"@namzu/sdk": minor
---

**Hardens the run lease.** A 34-agent review found ten defects in it; the worst let a cancelled run's tool execute anyway.

`cancelRun` is unfenced by design — a cancel that could not touch a run somebody is driving would be useless — so it can flip a run's status at any moment after a segment admitted itself. A single check at admission closed nothing: a worker could read `awaiting_input` a millisecond before the cancel landed, proceed, stamp its own state over `cancelled`, and run the tool the user had cancelled while the user was told the run was dead. A segment now re-checks at the four points where it can still stop without having done the irreversible thing, and a durable cancel reaches a *running* run for the first time — there was no channel at all before.

A transient filesystem error on a heartbeat no longer kills a healthy run: only a lost lease is a lost lease, and the retry budget is bounded by the TTL rather than by a magic number. The lease file is written atomically, and an unreadable one fails closed with a typed error instead of a `SyntaxError` — or, worse, being read as "free". A segment that lost its lease exits silently instead of declaring a run failed that somebody else owns. The fence is no longer check-then-act. An abandoned generator no longer renews its lease forever.

A `failed` run is now resumable under its own id. It is the one terminal state nobody chose, and refusing it bricked a run whose decision token was already spent — the only escape was a fork, which re-grants the whole lifetime budget, so a run stopped at its cost cap could be "recovered" into an unlimited one.
