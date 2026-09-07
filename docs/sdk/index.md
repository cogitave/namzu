# SDK

The kernel.

* [Run the kernel](quick-start.md) - An offline SDK run, real tool execution and conversation identity.
* [AG-UI clients](ag-ui.md) - Explicit host admission, backend tool streaming, shared UI state and CopilotKit connection limits.
* [Zen and Zen Go](zen.md) - Native model protocol routing, conversation attribution, validated reasoning replay and catalogue limits.
* [Bounded file discovery](file-discovery.md) - Explicit glob scope, incremental sandbox enumeration and recoverable incomplete results.
* [Bounded code execution](code-execution.md) - Opt-in tool batching, structured results and interpreter resource limits.
* [Answer verification](verification.md) - Command-backed review, cancellation, interrupted checks and honest completion boundaries.
* [Pinned facts](pinned-facts.md) - How a tool puts a fact into the run's working memory by key, so it stays in front of the model across compaction.
* [Structured memory](memory.md) - Store isolation, cross-process coordination, lexical search, lifecycle tools and bounded optional recall.
* [Cognitive architecture research](cognitive-architecture.md) - Draft process architecture, neuroscience motivation and bounded experiments for state, recall, action and evidence.
* [Cognitive storage research](cognitive-storage.md) - Pydantic AI source comparison and proposed boundaries for RAM, durable records, retrieval indexes and recovery.
* [Ids](ids.md) - Opaque UUIDs, nominal entity types and strict storage admission.
* [Hook events](hooks.md) - The events the kernel fires for extensions and shell hooks, what each carries, which can answer with a verdict, and the JSON a shell hook reads on stdin.
* [The review policy](review-policy.md) - The five modes a run resolves undecided tool calls under, which calls skip review, and how a host supplies the person to ask.
* [The salience-scored working set](salience-working-set.md) - Context scoring, multimodal token estimates, retention and recovery limits.

* [Harness invariants](harness-invariants.md) - Ownership, budget conservation, result recovery and bounded live execution evidence.

* [Token budgets](token-budgets.md) - Shared parent and descendant accounting, durable reservations and explicit recovery boundaries.
