# SDK

The kernel.

* [Bounded file discovery](file-discovery.md) - Explicit glob scope, incremental sandbox enumeration and recoverable incomplete results.
* [Pinned facts](pinned-facts.md) - How a tool puts a fact into the run's working memory by key, so it stays in front of the model across compaction.
* [Ids](ids.md) - Opaque UUIDs, nominal entity types and strict storage admission.
* [Hook events](hooks.md) - The events the kernel fires for extensions and shell hooks, what each carries, which can answer with a verdict, and the JSON a shell hook reads on stdin.
* [The review policy](review-policy.md) - The five modes a run resolves undecided tool calls under, which calls skip review, and how a host supplies the person to ask.
* [The salience-scored working set](salience-working-set.md) - Context scoring, multimodal token estimates, retention and recovery limits.

* [Harness invariants](harness-invariants.md) - Ownership, budget conservation, result recovery and bounded live execution evidence.

* [Token budgets](token-budgets.md) - Shared parent and descendant accounting, durable reservations and explicit recovery boundaries.
