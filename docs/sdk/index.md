# SDK

The kernel.

* [Schedules](schedules.md) - The schedule time engine and evaluator (cron, DST, catch-up) and the schedule and session_loop tools over host callbacks.
* [Manual compaction](manual-compaction.md) - Retain removed originals before publishing a host-requested history replacement.

* [Automatic conversation evidence recall](evidence-recall.md) - Scoped historical passages ranked within a bounded candidate pool and added only to the current request.
* [Request-only step context](step-context.md) - Changing observations after history (step context, working memory, `context` contributions), separate from system policy and operator intent.

* [Native structured output](native-structured-output.md) - Query response schemas, local validation and bounded correction.
* [Native provider admission](native-provider-capabilities.md) - Explicit driver support and fallback route checks.

* [Structured output review](structured-output-review.md) - Parsed-result validation, bounded corrections and checkpoint recovery.
* [Tool call budgets](tool-call-budget.md) - Durable per-turn admissions, batch limits and recovery accounting.
* [Environment exploration before learning](resident-exploration.md) - Active tool experiments and retained observations before independent skill evaluation.
* [Evaluating exploration policies](exploration-policies.md) - Purpose-bound learning instructions and independent measurement of evidence acquisition.

* [Tool discovery](tool-discovery.md) - Verified active matches, bounded deferred activation and allowed-tool filtering.
* [Toolsets](toolsets.md) - The unit every tool comes from, its composable wrappers, and combineToolsets's atomic conflict detection.
* [Host capabilities](host-capabilities.md) - Reusable per-run instructions, toolsets, guardrails, prompt contributions and model settings for runAgent.
* [Plugin toolsets and lifecycle](plugins.md) - File and in-code plugins, source ownership, MCP servers, request context and revocation.
* [Tool metadata and selectors](tool-metadata-and-selectors.md) - ToolDefinition.metadata as a host-only, never-on-the-wire data bag, matchesToolSelector's three selector shapes, and how an MCP server's annotations land in it.
* [Portable tool schemas](tool-schema-portability.md) - One rendering valid in draft-07 and 2020-12, the profile that defines it, the normaliser that enforces it, and the sibling sweep for an undescribed field.
* [Registry collisions](registries.md) - One collision policy, one base error class, and which registry chose which policy and why.

* [The computer_use tool](computer-actions.md) - Fitted, numbered screenshots and the coordinate contract, a screenshot after every action, batches, zoom, wait, windows, provider gating and exact per-host action declarations.
* [The computer-use host contract](computer-use-host.md) - Physical pixels at the host boundary, the display a capture shows, and the optional window, region-capture and accessibility-tree methods behind their capability flags.
* [Browser tools](browser-tools.md) - The browser and browser_act tools over a BrowserHost, canonical URLs and origins for site rules, snapshot framing and structural host errors.
* [The browser host](browser-host.md) - @namzu/browser's PlaywrightBrowserHost: engine detection, profiles and leases, the site policy after every navigation, the human-handoff classifier and snapshot refs.

* [Framework and computer-use gap audit](framework-gap-audit.md) - Verified boundaries against Pydantic AI, AG-UI and OpenBot, with next acceptance checks.

* [Model-owned reasoning capabilities](model-reasoning.md) - Provider-neutral catalogue metadata and exact session effort menus.
* [Model prices, and what an absent one means](model-prices.md) - Optional per-million rates on ModelInfo, why a driver omits a rate it never learned, and how a reader renders the absence.

* [Tool execution barriers](tool-execution.md) - Explicit batch ordering while independent read segments remain parallel.
* [Unreadable tool input](unreadable-tool-input.md) - Streamed tool arguments that do not parse: truncated or malformed by finish reason, what the model and host are told, and how tool-call fragments are grouped.
* [OpenAI reasoning menus](openai-reasoning.md) - Model-specific API and subscription effort levels and validation.

* [Run the kernel](quick-start.md) - An offline SDK turn, real tool execution, conversation identity and where the session is recorded.
* [Agent ownership](agent-ownership.md) - The SDK agent contract, the CLI's agent and example orchestration patterns.
* [AG-UI clients](ag-ui.md) - Explicit host admission, backend and frontend tools, interrupts and resume, shared UI state and CopilotKit connection.
* [Kubernetes sandboxes](kubernetes-sandbox.md) - Warm-pool claims on an agent-sandbox cluster, the pristine-claim rule, the per-instance agent credential, persistent block-disk workspaces and what is not built yet.
* [Firecracker sandboxes](firecracker-sandbox.md) - The Firecracker microvm tier against a self-hosted orchestrator, the reserve-then-execute path over the framed guest-agent wire, per-phase exec timing and the half-close contract a relay has to honour.
* [The container sandbox worker's credential](container-sandbox-worker.md) - The per-instance bearer token the container backend mints and the worker requires on every route but /healthz, the refusal that makes a routable bind without one impossible, the named escape and what it gives up, and the workers nobody can authenticate against.
* [Sandbox egress profiles](sandbox-egress-profiles.md) - One named, validated host allowlist with optional ports for the docker, runsc, firecracker and kubernetes backends, the port union rule, and what each backend refuses at construction.
* [Sandbox seeds](sandbox-seeds.md) - Git repositories prepared once by an idempotent ensureSandboxSeed step on storage that outlives the sandbox, where the root goes per backend, the untrusted marker, and the URL rules that keep credentials out of the guest.
* [Container-tier egress](sandbox-egress.md) - The internal-network topology that makes the docker tier's allowlist a kernel boundary rather than a proxy environment variable, the two images to build, the reach a sandbox keeps, and what is stated rather than measured.
* [Zen and Zen Go](zen.md) - Native model protocol routing, conversation attribution, validated reasoning replay and catalogue limits.
* [Bounded file discovery](file-discovery.md) - Explicit glob scope, incremental sandbox enumeration and recoverable incomplete results.
* [Bounded code execution](code-execution.md) - Opt-in tool batching, structured results and interpreter resource limits.
* [Advisory context](advisory-context.md) - Public trajectory records, source attribution, bounded text and consultation limits.
* [Answer verification](verification.md) - Command-backed review, cancellation, interrupted checks and honest completion boundaries.
* [Asking the user a question](user-questions.md) - The `ask_user_question` tool: its input, the `recommended` flag on an option, how a recommendation marker written into a label is taken out in any language, what the host is handed and the answer the model reads back.
* [Tool handoff](tool-handoff.md) - How a tool stops the turn for a person: `ToolResult.handoff`, the checkpoint and `turn_paused` after the batch is committed, resuming, and why a delegated child fails instead.
* [Pinned facts](pinned-facts.md) - How a tool puts a fact into the turn's working memory by key, so it stays in front of the model across compaction.
* [Structured memory](memory.md) - Typed records, one Markdown file per memory with a generated index, store isolation, cross-process coordination, lexical search, lifecycle tools and bounded optional recall.
* [Cognitive architecture research](cognitive-architecture.md) - Draft process architecture, neuroscience motivation and bounded experiments for state, recall, action and evidence.
* [Cognitive storage research](cognitive-storage.md) - Pydantic AI source comparison and proposed boundaries for RAM, durable records, retrieval indexes and recovery.
* [Ids](ids.md) - Opaque UUIDs, nominal entity types and strict storage admission.
* [Delegation events](delegation-events.md) - What the kernel says when a turn delegates to a child session, which fields a host may act on, which are captions for a screen, and what the logs keep.
* [Cross-session peer messaging (SDK)](peer-messaging.md) - The live-session registry, the namzu-peer/1 transport and the runtime-context rendering a delivered message or notice.
* [Hook events](hooks.md) - The events the kernel fires for extensions and shell hooks (`turn_start`, `turn_end`, `session_start`, …), what each carries, which can answer with a verdict, and the JSON a shell hook reads on stdin.
* [Skills and allowed-tools](skills.md) - Loading a SKILL.md through the skill tool, the directory a host tells the model a skill's files are in, and allowed-tools as a turn-scoped pre-approval that never narrows the tool set.
* [The bash tool](bash-tool.md) - Which shell the bash tool runs a command in, on the host and in a sandbox, and how the permission rules follow that choice.
* [How command lines are read](command-lines.md) - The one bash lexer behind command-line permission rules and skill Bash(<pattern>) grants, and when it calls a line opaque.
* [The review policy](review-policy.md) - The five modes a turn resolves undecided tool calls under, which calls skip review, and how a host supplies the person to ask.
* [Crossing the tool boundary](escalations.md) - A file tool's path outside the turn's roots, or a command outside its sandbox, as a reviewed question: `outsideRootAccess`, `sandboxEscape`, `confirmedEscalations` and the audit records.
* [The salience-scored working set](salience-working-set.md) - Context scoring, multimodal token estimates, retention and recovery limits.

* [Session log](session-log.md) - The one append-only, hash-chained JSONL file per session: record schema, turn rules, the fold, and the layout under NAMZU_HOME.

* [Harness invariants](harness-invariants.md) - Ownership, budget conservation, result recovery and bounded live execution evidence.

* [Token budgets](token-budgets.md) - One ledger per root turn, shared with its child sessions: accounting, durable reservations and explicit recovery boundaries.

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

* [The session index](sqlite-sessions.md) - The rebuildable index over every session log: sessions, turns, children, pending decisions, external ids and full-text search, in SQLite or scanned in memory.

* [Retained tool evidence](retained-tool-evidence.md) - Bounded indexed retrieval of original tool and conversation text from authorized session logs.
* [Assistant text phases](assistant-text.md) - Preserve public progress items while selecting settled answers and native replay.

* [Automatic resident tool evidence recall](resident-evidence-recall.md) - Bounded historical tool retrieval across settled resident admissions.

* [Cancellation and timeouts](cancellation-and-timeouts.md) - Findings and open composition options for provider-request cancellation, the whole-turn timeout gap, and the two idle-timeout mechanisms.

* [MCP protocol eras](mcp-protocol-eras.md) - The era model behind MCP negotiation, the single-round-trip legacy handshake across four versions, and why there is no waterfall.
* [MCP content blocks](mcp-content-blocks.md) - Which tool-result content types reach the model, which protocol revision introduced each, and how audio, resource_link and embedded resources are represented.
* [The MCP toolset](mcp-toolset.md) - mcpToolset(client, options): two live toolsets from a connected MCP server, with mcp__<server>__<rest> naming, deferred resource tools, and list_changed and reconnect updates.

* [Tool-result screening](tool-result-screening.md) - The registry boundary that judges a result before anything reads it, the four verdicts, what the two shipped screens decide and refuse to decide, and how a turn, a registry and the CLI each choose which ones apply.
