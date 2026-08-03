---
'@namzu/sdk': minor
---

A delegated run now joins the trace it belongs to.

Every run started its own ROOT span, including a spawned sub-agent's. A
supervisor delegating to three children produced four disconnected traces
instead of one tree — the same defect that made a 20-turn run show up as 21
roots before iterations were parented, except across the spawn boundary,
where the delegation structure is exactly what a trace is for.

`QueryParams.parentSpan` (and `ReactiveAgentConfig.parentSpan`) parents the
run span when a caller supplies one. The spawning tool passes its own span,
so a child run lands inside the turn that asked for it:

    tool span → child run → child iterations → child tool spans

A top-level run with no parent still starts its own root, which is correct:
it IS the root, and forcing one would be wrong.

The parent is stamped onto the child config after `configBuilder` runs
rather than relying on every builder to forward an option it may not know
about.
