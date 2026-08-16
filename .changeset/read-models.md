---
'@namzu/sdk': minor
---

An incremental read-model registry, with derived run status as its first driven consumer.

Everything derived from a run was computed by scanning what was in hand when somebody asked. `deriveRunStatus` takes a status and a park and answers about that instant — which works while the whole run fits in memory and stops working the moment it does not. A caller wanting the status of a run whose history has been compacted, or of a run in another process, loads the log and folds it, and every caller folds it slightly differently.

`ReadModelRegistry` is that fold, written once and advanced one event at a time. Its two refusals are what make "incremental" a property rather than a hope:

- A **duplicate** is refused, because it double-counts anything a model accumulates and nothing downstream can tell a doubled count from a real one.
- A **gap** is refused, because a projection built across one produces a state that looks complete while describing a log the registry never saw. A caller that has lost its place calls `replay`, which is honest about starting over.

One registry per run rather than per model, so `lastSeq` is one number and a caller reading two projections cannot be handed states derived from different prefixes of the same log. A refusal leaves every state untouched — a registry that refused after mutating half its models would be worse than one that accepted.

`createRunStatusReadModel` derives `RunStatus` from the events a run already emits, feeding `deriveRunStatus` rather than re-implementing it: two implementations of the same rule are two chances to disagree about what `awaiting_hitl_resolution` means, and the disagreement would show up as a run that reads differently depending on which surface asked. The two `awaiting_hitl*` variants had no producer at all before this.

`now` is injected because a deadline passes without any event being emitted, so what a fold holds is the status **as of the last event** — the honest thing for a projection to say, since nothing woke it up at the deadline.
