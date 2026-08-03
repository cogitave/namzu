---
'@namzu/sdk': minor
---

Step shaping composes

`prepareStep` was a single slot: enough for one concern and no help with two. A host with a per-tenant system prefix *and* a cost-based model downgrade had to hand-compose them into one callback, which puts the ordering in the host's own code where nothing can see it and makes each concern's failure the other's problem.

It now accepts an array. Stages run in **declaration order** — not registration order, and that distinction is the whole reason this is safe where a plugin-style fan-out would not be: the author writes the order down, so "who wins" is a line of their code rather than an accident of install history. Each stage sees what the ones before it decided through `context.prepared`, which is how a later stage refines an earlier one instead of guessing at it.

A stage that throws is skipped and the rest still run, because one broken concern must not silently disable the others it was declared beside. A single function behaves exactly as before.
