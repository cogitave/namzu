# SDK

The kernel.

* [Manual compaction](manual-compaction.md) - Retain removed originals before publishing a host-requested history replacement.

* [Automatic conversation evidence recall](evidence-recall.md) - Scoped historical passages ranked within a bounded candidate pool and added only to the current request.
* [Request-only step context](step-context.md) - Changing observations after history, separate from system policy and operator intent.

* [Native structured output](native-structured-output.md) - Query response schemas, local validation and bounded correction.
* [Native provider admission](native-provider-capabilities.md) - Explicit driver support and fallback route checks.

* [Structured output review](structured-output-review.md) - Parsed-result validation, bounded corrections and checkpoint recovery.
* [Tool call budgets](tool-call-budget.md) - Durable per-run admissions, batch limits and recovery accounting.
* [Environment exploration before learning](resident-exploration.md) - Active tool experiments and retained observations before independent skill evaluation.
* [Evaluating exploration policies](exploration-policies.md) - Purpose-bound learning instructions and independent measurement of evidence acquisition.

* [Tool discovery](tool-discovery.md) - Verified active matches, bounded deferred activation and allowed-tool filtering.
* [Portable tool schemas](tool-schema-portability.md) - One rendering valid in draft-07 and 2020-12, the profile that defines it and the normaliser that enforces it.

* [Computer action capabilities](computer-actions.md) - Exact supported actions and per-gesture mouse buttons.

* [Framework and computer-use gap audit](framework-gap-audit.md) - Verified boundaries against Pydantic AI, AG-UI and OpenBot, with next acceptance checks.

* [Model-owned reasoning capabilities](model-reasoning.md) - Provider-neutral catalogue metadata and exact session effort menus.

* [Tool execution barriers](tool-execution.md) - Explicit batch ordering while independent read segments remain parallel.
* [OpenAI reasoning menus](openai-reasoning.md) - Model-specific API and subscription effort levels and validation.

* [Run the kernel](quick-start.md) - An offline SDK run, real tool execution and conversation identity.
* [AG-UI clients](ag-ui.md) - Explicit host admission, backend tool streaming, shared UI state and CopilotKit connection limits.
* [Kubernetes sandboxes](kubernetes-sandbox.md) - Warm-pool claims on an agent-sandbox cluster, the pristine-claim rule, the per-instance agent credential, persistent block-disk workspaces and what is not built yet.
* [Zen and Zen Go](zen.md) - Native model protocol routing, conversation attribution, validated reasoning replay and catalogue limits.
* [Bounded file discovery](file-discovery.md) - Explicit glob scope, incremental sandbox enumeration and recoverable incomplete results.
* [Bounded code execution](code-execution.md) - Opt-in tool batching, structured results and interpreter resource limits.
* [Advisory context](advisory-context.md) - Public trajectory records, source attribution, bounded text and consultation limits.
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

* [Paired harness verification](harness-verification.md) - Trace-attributed comparison and fresh confirmation of harness candidates.
* [Memory retrieval research](memory-research.md) - Source-backed retrieval gaps, admission fix and evaluation priorities.
* [Measured automatic memory recall](memory-recall-scores.md) - Live paired Luna low correctness and consumption results.
* [Resident agents experiment](resident-agents.md) - Staged continuity plan, durable pursuit admission and bounded internal continuation.
* [Resident step context](resident-context.md) - Stable guidance and captured objective, evidence and learning for each admitted invocation.

* [Resident initiative experiment](resident-initiative.md) - Explainable selection, verified observations, bounded subgoal proposals and measured tradeoffs.

* [Resident communication experiment](resident-communication.md) - Atomic outbound intents, acknowledged delivery and explicit time windows.

* [Resident learning experiment](resident-learning.md) - Evidence-backed behavioral revisions, evaluated guidance and admitted context.
* [Durable resident learning records](resident-learning-storage.md) - Scoped SQLite journals, immutable artifacts and explicit host execution.
* [Resident learning cycle](resident-learning-cycle.md) - Generated guidance, independent evaluation, fresh confirmation and exact-revision activation.
* [Resident learning discovery](resident-learning-discovery.md) - Select retained failures and atomically admit one experiment per task, evaluator and baseline.
* [Resident retention and history](resident-retention.md) - Terminal archival with durable deduplication and ancestry limits.
* [Resident evidence recall](resident-recall.md) - Bounded reads of earlier settled summaries and consumed inputs within one pursuit.

* [SQLite session storage](sqlite-sessions.md) - Indexed session metadata and atomic ownership updates with the optional native SQLite driver.

* [Retained tool evidence](retained-tool-evidence.md) - Durable bounded indexing, authenticated output pages and scoped recall across resident invocations.
* [Assistant text phases](assistant-text.md) - Preserve public progress items while selecting settled answers and native replay.

* [Automatic resident tool evidence recall](resident-evidence-recall.md) - Bounded historical tool retrieval across settled resident admissions.

* [Cancellation and timeouts](cancellation-and-timeouts.md) - Findings and open composition options for provider-request cancellation, the whole-run timeout gap, and the two idle-timeout mechanisms.

* [MCP protocol eras](mcp-protocol-eras.md) - The era model behind MCP negotiation, the single-round-trip legacy handshake across four versions, and why there is no waterfall.
* [MCP content blocks](mcp-content-blocks.md) - Which tool-result content types reach the model, which protocol revision introduced each, and how audio, resource_link and embedded resources are represented.
