# SDK

The kernel.

* [Pinned facts](pinned-facts.md) - How a tool puts a fact into the run's working memory by key, so it stays in front of the model across compaction.
* [Ids](ids.md) - One prefix per id type, minted by a factory and checked by a constructor, and what a reader does with a prefix it no longer accepts.
* [Hook events](hooks.md) - The events the kernel fires for extensions and shell hooks, what each carries, which can answer with a verdict, and the JSON a shell hook reads on stdin.
* [The review policy](review-policy.md) - The five modes a run resolves undecided tool calls under, which calls skip review, and how a host supplies the person to ask.
* [The salience-scored working set](salience-working-set.md) - The work plan that turns "every message is scored and the context changes dynamically" from a promise into the kernel's context-management algorithm, phase by phase, with what each phase must prove.
