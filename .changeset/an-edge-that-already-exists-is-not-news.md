---
'@namzu/sdk': patch
---

`InMemoryTaskStore.block()` stops announcing an edge that already existed.

The two task stores disagreed about what `task.updated` means. `block()` is
idempotent on both — each guards its array against a duplicate entry — but only
the disk store guarded the *announcement*. Calling `block(a, b)` twice emitted
two `task.updated` events from the in-memory store and one from the disk store,
which is the one a host runs in production.

So a host rebuilding a dependency graph from the event stream did redundant
work against the reference implementation and not the durable one, and a host
counting events to detect change saw change where there was none. The
divergence is the kind that stays invisible until a store is swapped.

The disk store's behaviour was already correct and is now the behaviour of
both. No event is lost: a call that establishes a new edge — including one that
repairs a half-edge, where only one of the two arrays grows — still announces
both ends, because both ends are one fact.

The disk store's side of this had no test, which is why the disagreement
survived. Both are now driven from the same cases.
