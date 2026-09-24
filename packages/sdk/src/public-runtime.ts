// Public runtime surface of `@namzu/sdk`.
//
// Every runtime value a consumer might need: classes (agents, managers,
// stores, registries), functions (helpers, ID generators, runtime entry
// points), zod schemas, constants, error classes. The three-bucket taxonomy
// was ratified in ses_011-sdk-public-surface §4.2.
//
// Rule: no type-only exports here (types live in public-types.ts). No tool
// definitions or builders (tools live in public-tools.ts).

// ─── version + config ────────────────────────────────────────────────────

export { VERSION } from './version.js'

// The opt-in model-authored-code backend. `RunCodeToolOptions.runtime` has
// always accepted this contract; exporting the implementation and its refusal
// class makes that signature nameable from the package root.
export { HostCallDeniedError } from './execution/code-runtime/types.js'
export { WorkerCodeRuntime } from './execution/code-runtime/worker.js'

export {
	CompactionConfigSchema,
	PluginRuntimeConfigSchema,
	RUNTIME_DEFAULTS,
	RuntimeConfigSchema,
	SandboxConfigSchema,
	TaskRouterConfigSchema,
} from './config/runtime.js'

// ─── constants ───────────────────────────────────────────────────────────

export * from './constants/index.js'

export {
	ConfigNamespaceCollisionError,
	ConfigRegistry,
} from './config/registry.js'
export type { ConfigRegistryOptions, ConfigScope } from './config/registry.js'
export {
	DiskConfigOverrideStore,
	InMemoryConfigOverrideStore,
} from './store/config/index.js'
export type { ConfigOverrideStore } from './store/config/index.js'
export {
	MCPReconnectOptionsSchema,
	MCPReconnectSupervisor,
} from './connector/mcp/reconnect.js'
export type {
	MCPReconnectOptions,
	MCPReconnectPolicySource,
} from './connector/mcp/reconnect.js'

export type {
	CodeNavigationProvider,
	CodeNavigationResult,
	HoverResult,
	SourceLocation,
	SymbolLocation,
	SymbolSearchResult,
} from './types/code-navigation/index.js'

// ─── wire schemas + a2a (contracts/) ─────────────────────────────────────

// Turn and session schemas (CreateTurnSchema, CreateEphemeralSessionSchema,
// TurnConfigSchema, TurnIdSchema, SessionIdSchema, …) come through
// `export * from './contracts/session/index.js'` at the end of this file.
export {
	CreateMessageSchema,
	MessageIdSchema,
	PaginationSchema,
	ProjectIdSchema,
	zodErrorToApiError,
} from './contracts/schemas.js'

export * from './contracts/a2a.js'

// ─── ID generators + parsers ─────────────────────────────────────────────

export * from './utils/id.js'

// ─── utility helpers ─────────────────────────────────────────────────────

export {
	accumulateCost,
	accumulateUnpricedCost,
	calculateCost,
	describeCost,
	formatCost,
	ZERO_COST,
} from './utils/cost.js'

// The price catalogue. Exported because a driver package has to be able to ask
// whether the models it offers an operator are ones the kernel can price —
// `sdk ← providers` means the SDK's own tests can never reach a real driver's
// model list, so that check lives in the driver and needs this.
export {
	normaliseModelId,
	resolveModelPricing,
	VENDOR_RATES,
} from './pricing/index.js'
export { toErrorMessage } from './utils/error.js'
export { getLogCounters, Logger } from './utils/logger.js'
/**
 * The process sink's own counter set, for a host that installs a sink and
 * then builds its own logger from it.
 *
 * Exported by LOG-20 out of necessity rather than design. Removing
 * `getRootLogger` removed `fromSink`, which was the only thing passing this
 * set into a `createLogger`. Without it every host-written record counts into
 * a private set, `getLogCounters()` reports a permanently zeroed one, and
 * `namzu doctor`'s `logging.pipeline` check reads health it never measured —
 * a check that cannot fail, introduced by the removal that was supposed to
 * end them.
 */
export { getProcessSinkCounters } from './utils/log/process-sink.js'

// The LogSink seam — additive. `Logger`/`getRootLogger`/`configureLogger`
// above are unchanged; this is the new seam that replaces them going
// forward once a host (the CLI) is migrated to call it.
export {
	createLogger,
	EVENT_NAME_ATTRIBUTE,
	installProcessSink,
	jsonLinesSink,
	LevelFilter,
	LogAttributes,
	LogRecord,
	LogSink,
	LogSinkCounters,
	NOOP_LOGGER,
	NOOP_SINK,
	prettySink,
	Resource,
	SCOPE_ATTRIBUTE,
	Severity,
} from './utils/log/index.js'

// A cancellation carries its origin; these are what a host reads it with.
// `cancelCauseOf` is exported alongside the class because a host
// implementing its own gateway holds an abort REASON, not a TurnCancelled.
export { cancelCauseOf, TurnCancelled } from './types/session/cancel-cause.js'

// A tool authors how it is shown; a host resolves through this rather than
// switching on a lowercased tool name, which is what left every MCP and
// plugin tool with a truncated string no matter what it did.
// Credential resolution as a seam. All provider credential discovery lived
// in the CLI, so a host embedding the SDK alone had no way to plug in an
// env- or file-backed source without reimplementing an interface that asks
// a different question.
// The collaboration mode, durable per Topic. It was resolved once per turn
// and copied into the executor, so leaving plan mode meant ending the turn
// and discarding the in-flight step to change one enum.
// The object a host holds between turns. There was none: no way to ask
// whether the agent is running, and nowhere to put "when you next run,
// start with this".
export { AgentNotRunningError, createAgentHandle } from './agents/handle.js'

export {
	DiskTopicStateStore,
	InMemoryTopicStateStore,
} from './store/topic/state.js'
export { StaleTopicStateError } from './types/topic/state.js'

// Work that outlives one turn. Named explicitly here rather than reached
// through the sub-barrels, because this file re-exports SELECTED names from
// `./manager/index.js` and friends rather than star-exporting them — so a
// name added to a sub-barrel alone never reaches the package entry at all.
// That is exactly what happened to this API when it landed: fully exported
// from its module, fully invisible to a consumer, and the public-surface
// gate said nothing because it reads the built entry point.
export {
	DiskTopicObjectiveStore,
	InMemoryTopicObjectiveStore,
	ObjectiveExhaustedError,
	ObjectiveExistsError,
} from './store/topic/objective.js'
export {
	ObjectiveNotProgressingError,
	advanceObjective,
	driveObjective,
} from './manager/topic/objective.js'
export { StaleObjectiveError } from './types/topic/objective.js'

// A completion goal belongs to one durable Session. The direct host command
// consumes this store; automatic continuation is a separate driver rather
// than a side effect hidden inside persistence.
export {
	DEFAULT_MAX_GOAL_ROUNDS,
	DiskSessionGoalStore,
	GoalExistsError,
	GoalNotFoundError,
	GoalRoundLimitError,
	GoalSessionNotFoundError,
	GoalTransitionError,
	InMemorySessionGoalStore,
	MAX_GOAL_OBJECTIVE_CHARS,
	StaleGoalError,
} from './store/goal/index.js'

export {
	EnvCredentialProvider,
	ReadOnlyCredentialProviderError,
} from './vault/CredentialProvider.js'
// The key-name vocabulary itself, so a host with its own provider registry
// can assert its variables are ones the host-bash scrub will withhold —
// the check that stops the two tables drifting apart.
export { isCredentialEnvKey } from './constants/credential-env-keys.js'

export {
	createToolPresenter,
	genericLabel,
} from './registry/tool/presentation.js'
export type { ToolPresenter } from './registry/tool/presentation.js'

// A stalled stream trips no request timeout — the request succeeded and
// the bytes stopped. Composes with withProviderRetry/withProviderFallback:
// the failure is classified `network`, which both already act on.
// One header, so a vendor reading its own logs can tell a kernel's traffic
// from a browser's — and so an abuse or rate-limit investigation lands on
// the right party.
export {
	NAMZU_APP_IDENTITY,
	attributionHeaders,
} from './provider/attribution.js'
export type { AppIdentity } from './provider/attribution.js'

export {
	DEFAULT_STREAM_IDLE_TIMEOUT_MS,
	withStreamIdleTimeout,
} from './provider/idle-timeout.js'
export type { WithStreamIdleTimeoutOptions } from './provider/idle-timeout.js'
export { DEFAULT_MAX_REQUEST_RICH_CONTENT_BYTES } from './runtime/query/request-rich-content.js'
export { DEFAULT_SANDBOX_TEARDOWN_TIMEOUT_MS } from './runtime/query/sandbox-lifecycle.js'

export { isTrustedReadOnly } from './tools/trusted-read-only.js'
export {
	GoalRoundAuthorityError,
	MIN_GOAL_BLOCK_ROUND,
	SESSION_GOAL_TOOL_NAMES,
	buildSessionGoalTools,
} from './tools/goal/index.js'
export { SessionGoalActivation } from './manager/goal/activation.js'
export { buildToolResultHashes, hashToolResult } from './utils/hash.js'
export {
	compressShellOutput,
	compressShellOutputFull,
} from './utils/shell-compress.js'
export { createChildAbortController } from './utils/abort.js'
export { memoizeAsync } from './utils/memoize.js'
export { extractFinalResponse } from './utils/conversation.js'

// ─── router, runtime, turn ───────────────────────────────────────────────

export { resolveTaskModel } from './model-router/task-router.js'
// Every driver accepts `thinking`; one that does not implement it must
// refuse rather than drop it. Shared so a new driver inherits the rule.
export { assertThinkingUnsupported } from './provider/thinking-support.js'
// One matcher for versioned model ids. Shared because three drivers had each
// written their own and all three read an 8-digit date suffix as the MINOR
// version, which inverted every capability decision keyed on it. The shape
// lives here; the vocabulary comes from the driver that knows it.
export {
	modelVersionAtLeast,
	parseVersionedModelId,
} from './provider/model-version.js'
// Strict tool input is a SUBSET of JSON Schema, and a keyword outside it makes
// the vendor reject the whole request rather than degrade one field.
export {
	assertStrictSchema,
	findStrictSchemaViolations,
} from './provider/strict-schema.js'
// A tool has one schema; what changes per provider is the DIALECT the wire
// parses, which is the wire's property. Rendered once, converted at the driver.
export { findDraft07Only, toSchemaDialect } from './registry/tool/dialect.js'
export type { JsonSchemaDialect } from './registry/tool/dialect.js'
// Better than converting per wire: emit the INTERSECTION of the dialects, so
// there is nothing left for a driver to convert and an unmeasured wire is safe
// by construction. Exported so a driver or a CI gate can assert it.
export {
	findPortableSchemaViolations,
	toPortableToolSchema,
} from './registry/tool/portable.js'
export type { PortableSchemaViolation } from './registry/tool/portable.js'
// The renderer itself, so a driver or a contract test can ask what a tool will
// actually put on the wire without reaching into the registry.
export { renderToolSchema, toolWireSchema } from './registry/tool/schema.js'
export type { StrictSchemaViolation } from './provider/strict-schema.js'
export type { ModelIdGrammar, ModelVersion } from './provider/model-version.js'
export { drainQuery, query } from './runtime/query/index.js'
export {
	collapseProjectInstructionSnapshots,
	isProjectInstructionMessage,
	replaceProjectInstructionSnapshot,
} from './runtime/query/project-instructions.js'
// Mid-run guidance. A host holds the channel and the loop drains it at the
// tool-result boundary; see the module for why that is the only legal slot.
export {
	SteeringBinding,
	attachSteering,
	formatSteeringNote,
} from './runtime/query/steering.js'
export type { SteeringChannel } from './runtime/query/steering.js'
export {
	BidiSessionCloseTimeoutError,
	createMockBidiProvider,
	startBidiTurn,
} from './runtime/bidi/index.js'
export { PromptCache } from './runtime/query/prompt-cache.js'
export {
	CheckpointManager,
	findPendingCheckpoint,
	isExpiredPark,
	listExpiredParks,
} from './runtime/query/checkpoint.js'
// Projecting what a turn records onto the domain `TurnStatus`.
export { deriveTurnStatus } from './types/session/derive-status.js'
// Scoped approval memory: the mechanism that lets an approver choose how
// wide their yes is, instead of choosing between 'this one call' and
// 'everything for the session'.
export { ToolGrantSet, toolGrantKeys } from './runtime/query/tool-grants.js'
// A skill's `allowed-tools` as a turn-scoped pre-approval: the parser, the
// compiler a host can run against its own registry, the per-turn set, and
// the one permission-glob dialect the CLI's `[permissions]` table shares.
export {
	SKILL_TOOL_NAME_ALIASES,
	SkillGrantSet,
	compileSkillGrant,
	permissionPatternToRegExpSource,
} from './authorization/skill-grant.js'
export type { ToolGrantKeys } from './runtime/query/tool-grants.js'
// `toWireTurnStatus` comes through `./contracts/session/index.js`.
// Durable turn state: the snapshot a different process picks a turn up from.
export {
	captureTurnState,
	loadSelectedTurnState,
	loadTurnState,
} from './runtime/query/turn-state.js'
export type { TurnStateScope } from './runtime/query/turn-state.js'
export {
	TURN_STATE_VERSION,
	TurnStateVersionError,
	parseTurnState,
} from './types/session/turn-state.js'
// …and the driver that joins the snapshot back to a running loop: the same
// session and the same turn.
export { resumeSession } from './runtime/query/resume-session.js'
export type {
	ResumeOutcome,
	ResumeSessionParams,
} from './runtime/query/resume-session.js'
// Closing a paused or interrupted turn without resuming it, and compacting a
// session between turns.
export { abandonTurn } from './runtime/query/abandon-turn.js'
export type { SessionLocatorOptions } from './runtime/query/abandon-turn.js'
export { compactSession } from './runtime/query/compact-session.js'
export type { CompactSessionParams } from './runtime/query/compact-session.js'
export { prepareForkState } from './runtime/query/fork/prepare.js'
export { listCheckpoints } from './runtime/query/fork/list.js'
export { DecisionParser, FallbackResolver } from './runtime/decision/index.js'
export {
	buildLimitConfig,
	checkLimitsDetailed,
	createTurnReporter,
} from './turn/index.js'
// One bounded pass over the parked turns: list the pending decisions nobody
// holds, claim the session, resume the turn, release in a `finally`. Not a
// daemon: it makes one pass and returns.
export { DEFAULT_DRAIN_PAGE_SIZE, drainParkedTurns } from './turn/index.js'
export type {
	DrainFailure,
	DrainTurn,
	DrainTurnsParams,
	DrainTurnsResult,
} from './turn/index.js'
// A `ReviewAnswer` that runs shell commands, so "don't finish until the
// build passes" needs no TypeScript. `reviewAnswer` was the seam for this
// and nothing shipped supplied one. Skips re-running a command whose
// failure the workspace has not changed since — the difference between a
// bounded loop and one that spends its whole budget confirming a failure it
// already reported.
export {
	DEFAULT_GATE_MAX_RETRIES,
	DEFAULT_GATE_OUTPUT_CHARS,
	DEFAULT_GATE_TIMEOUT_MS,
	FINGERPRINT_MAX_BYTES,
	FINGERPRINT_TIMEOUT_MS,
	clipOutput,
	createCommandGate,
	createJsonClaimVerifier,
	fingerprintWorkspace,
} from './turn/index.js'
export type {
	CommandGateOptions,
	FingerprintExec,
	GateExec,
	WorkspaceFingerprintOptions,
} from './turn/index.js'
// The default `promoteMemory`: write what a turn learned into a MemoryStore,
// or write NOTHING. A turn that learned nothing leaves no record at all —
// the model reads this store, so noise here is context spent on a turn that
// did nothing.
export { SESSION_MEMORY_TAG, createMemoryPromoter } from './turn/index.js'
export type { MemoryPromoterOptions } from './turn/index.js'
export { createMemoryRecallStep } from './turn/memory-recall.js'
export type { MemoryRecallOptions } from './turn/memory-recall.js'
export { createEvidenceRecallStep, refineEvidenceRecallTerms } from './turn/evidence-recall.js'
export type {
	EvidenceRecallOptions,
	EvidenceRecallRequest,
	EvidenceRecallBatch,
	EvidenceRecallCandidate,
	EvidenceRecallContinuation,
} from './turn/evidence-recall.js'

// ─── personas, skills, advisory ──────────────────────────────────────────

export {
	assembleSystemPrompt,
	mergePersonas,
	withSessionContext,
} from './persona/index.js'
export {
	discoverSkills,
	loadSkill,
	resolveSkillChain,
	SKILL_FRONTMATTER_KEYS,
	SkillRegistry,
} from './skills/index.js'
// The one frontmatter reader. `loadSkill` is built on it, and a host reading
// its own markdown — a command file, a prompt template — uses the same one
// rather than hand-rolling a second that disagrees about CRLF or about whether
// a malformed file throws or quietly returns nothing.
export { parseFrontmatter } from './utils/frontmatter.js'

// ─── the agent directory ─────────────────────────────────────────────────
//
// Reading a conventional `agent/` directory — its instructions, tools, skills
// and delegates — into the same options `runAgent` and `SupervisorAgent`
// already take. A loader, not a second engine: everything it produces is an
// ordinary option, so a caller who outgrows the convention passes overrides
// or stops calling it and keeps everything else.
//
// It shipped briefly as its own package. The name was the tell — nothing fit,
// because a directory reader that needs the kernel to be useful is a function
// of the kernel, not a product beside it.
export {
	ALL_SLOTS,
	deriveSupervisorOptions,
	deriveTurnOptions,
	loadDirectory,
} from './directory/index.js'
export {
	AdvisorRegistry,
	AdvisoryContext,
	AdvisoryExecutor,
	TriggerEvaluator,
} from './advisory/index.js'

// ─── agents ──────────────────────────────────────────────────────────────

export {
	AbstractAgent,
	ConcurrentInvocationError,
	defineAgent,
	InvocationLock,
	PipelineAgent,
	ReactiveAgent,
	RouterAgent,
	// The short path: provider + model + prompt. Assembles the identity and
	// budgets `drainQuery` requires and hands the generated identity back.
	runAgent,
	DEFAULT_MAX_ITERATIONS,
	DEFAULT_TIMEOUT_MS,
	DEFAULT_TOKEN_BUDGET,
	SupervisorAgent,
	DEFAULT_RESERVED_AGENT_NAMES,
	discoverAgentDefinitions,
	EXPLORE_AGENT_DESCRIPTION,
	EXPLORE_AGENT_ID,
	EXPLORE_AGENT_PROMPT,
	MAX_AGENT_FILE_CHARS,
	parseAgentFile,
	parseAgentMarkdown,
} from './agents/index.js'

// ─── registries, stores, managers, plugin, gateway ───────────────────────

export {
	ActivityStore,
	DiskMemoryStore,
	DiskTaskStore,
	InMemoryMemoryIndex,
	InMemoryMemoryStore,
	InMemoryStore,
	InMemoryTaskStore,
	MEMORY_INDEX_LINE_MAX_CHARS,
	MEMORY_INDEX_MAX_LINES,
	MarkdownMemoryStore,
	MEMORY_VERIFY_NOTICE,
	MemoryContentRejectedError,
	MemoryNameConflictError,
	describeMemoryAge,
	isMemoryName,
	memoryIndexLine,
	memoryLinkNames,
	renderMemoryIndex,
	slugifyMemoryName,
} from './store/index.js'
// The task-context rule (open tasks from any turn, plus the ones this turn
// closed), and the refusal of a task store bound to another session.
export { selectTaskContext } from './store/task/context.js'
export { TaskSessionMismatchError } from './store/task/disk.js'
// Cross-process possession of a session: its `lease.json`. Listing what is
// waiting (pending decisions, turns, children) is `SessionIndex`'s job, which
// comes through `./store/session-index/index.js` at the end of this file.
export {
	claimSession,
	fencedOut,
	releaseSession,
	toClaimSummary,
} from './store/session-claim.js'
// Walking the actor chain — exported so the next cross-tree concern (an
// audit over a subtree, a host asking whether one turn is contained by
// another) composes with the chain that is already persisted, rather than
// building a second parent registry beside it.
export {
	actorChain,
	isDescendantOfActor,
	MAX_ACTOR_CHAIN_DEPTH,
} from './session/actor-scope.js'
export {
	DiskMessageFeedbackStore,
	InMemoryMessageFeedbackStore,
	StaleFeedbackError,
	UnknownMessageError,
} from './store/feedback/index.js'
// Deciding what a reconnecting consumer's cursor is owed.
export { resolveSessionLogReplay } from './types/session/log-cursor.js'

// Commands a HOST offers its operator. Deliberately NOT tools: no
// descriptor reaches a provider and no dispatch path reaches the model — a
// `/tasks` readout is a question the operator asked, and making it callable
// would let the model spend a turn on it and record the output as a finding.
export {
	HostCommandNameCollisionError,
	HostCommandRegistry,
	kernelHostCommands,
} from './registry/command/index-exports.js'

export {
	AgentRegistry,
	BaseRegistry,
	ManagedRegistry,
	PluginRegistry,
	ToolCatalog,
	ToolNameCollisionError,
	ToolRegistry,
	createToolCatalogFromRegistry,
	loadingFromAvailability,
	toolDefinitionToCatalogEntry,
} from './registry/index.js'

export {
	attachShellHooks,
	createShellHook,
	DEFAULT_SHELL_HOOK_TIMEOUT_MS,
	discoverAllPluginDirs,
	discoverPlugins,
	loadPluginManifest,
	MAX_SHELL_HOOK_TIMEOUT_MS,
	PluginLifecycleManager,
	PluginResolver,
	runShellHook,
	SHELL_HOOK_EVENTS,
	SHELL_HOOKS_PLUGIN_ID,
	shellHookMatches,
	shellHookVerdict,
} from './plugin/index.js'

export {
	AgentManager,
	PlanManager,
	ProjectManager,
	// The gate itself, not only the manager that wraps it. A host writing its
	// own ingress path — a custom handoff, a queue consumer that creates
	// sessions — needs to refuse a closed workspace without constructing a
	// manager, which is the reason it is a function over a store.
	requireOpenProject,
	TopicManager,
	/**
	 * @deprecated Use {@link TopicManager}. A literal identity re-export, not a
	 * wrapper, so `instanceof` and `===` still hold for callers who have not
	 * migrated. Removal is NZ-TOPIC-05 -- NZ-TOPIC-01 marked it deprecated but
	 * that release never reached npm, so this major is the first one a consumer
	 * can actually see the warning in.
	 */
} from './manager/index.js'

// Records one turn into its session log.
export { TurnRecorder } from './manager/session/turn-recorder.js'

export {
	InMemoryTopicStore,
	/** @deprecated Use {@link InMemoryTopicStore}. Removal is NZ-TOPIC-05. */
} from './store/topic/memory.js'

export { LocalTaskScheduler } from './scheduler/local.js'

// A delegate need not be an in-process Namzu agent. `DelegatingTaskScheduler`
// presents any set of `Delegate`s as the `TaskScheduler` the delegation
// tools already speak, so a specialist can move out of process without a
// caller learning that it did.
export {
	DelegateCapabilityError,
	DelegateCapabilityMismatchError,
	DelegateIdCollisionError,
	DelegatingTaskScheduler,
	NoDelegateError,
} from './scheduler/delegating.js'
export type { DelegatingTaskSchedulerConfig } from './scheduler/delegating.js'
export type {
	Delegate,
	DelegateCapabilities,
	DelegateRequest,
	DelegateResult,
} from './types/agent/delegate.js'
// Exported because `buildCoordinatorTools` is: a host that builds the
// coordinator surface itself needs the same inbox the loop drains, or its
// abandoned completions go unheard exactly as they did before.
export {
	CompletionInbox,
	formatCompletionNotification,
} from './scheduler/completion-inbox.js'

// Scheduled jobs: WHEN something is due, and nothing about how a host stores
// or runs a job. The time engine and the evaluator are pure (`Intl` for time
// zones, no clock, no I/O); the CLI keeps its job files and history to itself.
export {
	countOccurrences,
	describeSchedule,
	evaluateJob,
	hostTimeZone,
	nextFireTime,
	parseCronExpression,
	parseDuration,
	parseScheduleSpec,
	previousFireTime,
	SCHEDULE_CATCH_UP_WINDOW_MS,
	SCHEDULE_LATE_GRACE_MS,
	ScheduleValidationError,
	upcomingFireTimes,
	validateTimeZone,
} from './schedules/index.js'

// ─── providers, sandbox, vault ───────────────────────────────────────────

export {
	classifyProviderError,
	DEFAULT_PROVIDER_RETRY,
	DuplicateProviderError,
	isAbortError,
	isProviderError,
	LazyProviderLoadError,
	LazyProviderSyncCreateError,
	MOCK_CAPABILITIES,
	MockLLMProvider,
	parseRetryAfterMs,
	PERMISSIVE_PROVIDER_CAPABILITIES,
	ProviderError,
	ProviderRegistry,
	ProviderRequestError,
	registerMock,
	resolveProviderCapabilities,
	UnknownProviderError,
	withProviderFallback,
	withProviderRetry,
} from './provider/index.js'
export type {
	ProviderChainMember,
	ProviderRetryConfig,
	WithProviderFallbackOptions,
	WithProviderRetryOptions,
} from './provider/index.js'
// The curve `ProviderRetryConfig` extends and `query({ toolRetryBackoff })`
// takes a partial of. Both public surfaces name it, so a consumer has to be
// able to name it too — a type reachable only through an inline `import(...)`
// in a `.d.ts` is not a type anyone writes down.
export type { BackoffPolicy } from './utils/backoff.js'

export {
	assertIsolation,
	describeIsolation,
	isolationOf,
	LocalSandboxProvider,
	missingIsolation,
	SandboxProviderFactory,
	walkFilesViaExec,
} from './sandbox/index.js'
export type { LocalSandboxProviderOptions, SandboxFileWalkExec } from './sandbox/index.js'

// The classified provider-failure surface: a driver states what went wrong
// first-hand, and the turn boundary reads it to choose between a pause and a
// failure.
// `classifyProviderHttpStatus` and `bodySaysContextOverflow` are here
// because a driver outside this repo needs the same classification the
// first-party ones use — a status code alone does not separate a context
// overflow from an ordinary bad request, and re-deriving that per driver
// is how the classifications drift apart.
export {
	bodySaysContextOverflow,
	classifyProviderHttpStatus,
	isCallerAbortError,
	isProviderRequestError,
	providerHttpError,
	providerVendorError,
} from './provider/errors.js'

export { InMemoryCredentialVault } from './vault/index.js'

// ─── RAG runtime (generic; createRAGTool is in public-tools.ts) ──────────

export {
	assembleRAGContext,
	cosineSimilarity,
	DEFAULT_CHUNKING_CONFIG,
	DEFAULT_EMBEDDING_REQUEST_TIMEOUT_MS,
	DEFAULT_RAG_CONTEXT_CONFIG,
	DEFAULT_RETRIEVAL_CONFIG,
	DefaultIngestionPipeline,
	DefaultKnowledgeBase,
	DefaultRetriever,
	InMemoryVectorStore,
	HttpEmbeddingProvider,
	TextChunker,
} from './rag/index.js'

// ─── connectors ──────────────────────────────────────────────────────────

export {
	BaseConnector,
	BaseExecutionContext,
	CommandCancellationUnsupportedError,
	ConnectorManager,
	ConnectorRegistry,
	EnvironmentConnectorManager,
	ExecutionContextFactory,
	HttpConnector,
	applyNamePolicy,
	applyToolPolicy,
	diffTools,
	hasDrift,
	HttpSseTransport,
	HybridExecutionContext,
	buildEnvelope,
	classifyModernHttpFailure,
	createMcpEraCache,
	decodeResult,
	defaultMcpEraCache,
	encodeMcpHeaderValue,
	isHeaderMismatchError,
	isMissingRequiredClientCapabilityError,
	isRecognizedModernError,
	isResourceNotFoundError,
	isUnsupportedProtocolVersionError,
	LocalExecutionContext,
	mcpEraCacheKey,
	MCPHttpStatusError,
	MCPInputRequiredError,
	MCPInvalidResultTypeError,
	MCPClient,
	MCPMethodNotFound,
	MCPConnectorBridge,
	MCPProtocolError,
	MCPServer,
	MCPToolDiscovery,
	resolveMcpEra,
	mcpPromptToToolDefinition,
	renderPromptMessages,
	mcpJsonSchemaToZod,
	mcpToolResultToToolResult,
	mcpToolToToolDefinition,
	RemoteExecutionContext,
	RemoteExecutionBusyError,
	ScopedConnectorRegistry,
	// The only transport in the tree that can RUN an `MCPServer`. It reached
	// `connector/mcp/index.ts` and stopped there, so the server was public
	// with no public way to serve it.
	ServerStdioTransport,
	StdioTransport,
	StreamableHttpTransport,
	TenantConnectorManager,
	toolDefinitionToMCPTool,
	toolResultToMCPToolResult,
	toolsHash,
	validateMcpHeaderAnnotations,
	WebhookConnector,
	zodToMCPJsonSchema,
} from './connector/index.js'
export type {
	McpEnvelope,
	McpEnvelopeInput,
	McpEraProbe,
	McpEraProbeAnswer,
	McpEraResolution,
	McpEraResolutionInput,
	McpHeaderAnnotationVerdict,
	McpParamHeaderBinding,
	MCPDecodedResult,
	MCPToolDiscoveryOptions,
	MCPToolDrift,
	MCPToolPolicy,
	MCPToolPolicyDecision,
} from './connector/index.js'

// ─── bridges (a2a + sse) ─────────────────────────────────────────────────

export {
	a2aMessageToCreateTurn,
	a2aMessageToInput,
	buildAgentCard,
	extractTextFromA2AMessage,
	isTerminalState,
	mapSessionToA2AEvent,
	mapTurnToA2AEvent,
	mapTurnToA2ATask,
	messageToA2A,
	resolveA2AContext,
	turnStatusToA2AState,
} from './bridge/a2a/index.js'
export { resolveExternalSession } from './bridge/external-session.js'

// The client half. Until this landed the bridge was a one-way door: this
// kernel served a card and could read nobody else's, so the delegate seam
// had no driven consumer.
export {
	A2ADelegate,
	A2AProtocolMismatchError,
	A2ARequestError,
	InvalidAgentCardError,
	fetchAgentCard,
} from './bridge/a2a/client.js'
export type {
	A2ADelegateConfig,
	FetchAgentCardOptions,
	FetchLike,
} from './bridge/a2a/client.js'

export {
	mapSessionEventToStreamEvent,
	mapSessionToStreamEvent,
} from './bridge/sse/index.js'

export {
	ACP_DEFAULT_REJECTION,
	ACPServer,
	clientBackedSandbox,
	toAcpSessionUpdate,
	toAcpStopReason,
	toResumeDecision,
} from './bridge/acp/index.js'
export type {
	AcpAgentGateway,
	AcpClientFilesystem,
	AcpPermissionAsker,
	AcpPermissionOutcome,
	AcpPermissionRequest,
	AcpServerOptions,
} from './bridge/acp/index.js'
export type {
	AcpFsReadParams,
	AcpFsReadResult,
	AcpFsWriteParams,
	AcpRequestPermissionParams,
	AcpRequestPermissionResult,
	AcpSessionLoadParams,
	AcpClientCapabilities,
	AcpInitializeParams,
	AcpInitializeResult,
	AcpSessionCancelParams,
	AcpSessionNewParams,
	AcpSessionNewResult,
	AcpSessionPromptParams,
	AcpSessionPromptResult,
	AcpSessionUpdate,
	AcpSessionUpdateNotification,
	AcpStopReason,
} from './types/acp/index.js'

// ─── bus, verification ───────────────────────────────────────────────────

export {
	AgentBus,
	CircuitBreaker,
	EditOwnershipTracker,
	FileLockManager,
} from './bus/index.js'

// `describeRule` travels with `evaluateRule` deliberately. `evaluateRule`
// answers WHETHER a rule matched; on its own it leaves a caller holding a
// decision with no words for it, and the only way to say anything about the
// refusal is to switch on the rule's TYPE — which names the kind of rule and
// nothing about what it said. That is precisely the defect the gate itself
// carried until its reason stopped being `Matched rule: <type>`, and shipping
// the verdict without the sentence would have left the same hole one layer up
// for anyone driving the rules directly instead of through the gate.
export {
	PERMISSION_PRESETS,
	SANDBOXED_PRESET,
	SANDBOXED_SHELL_PRESET,
	SUPERVISED_PRESET,
	UNATTENDED_PRESET,
	UnsupportedPermissionPresetError,
	availablePermissionPresets,
	defaultSandboxedGateConfig,
	permissionPreset,
	resolvePermissionPreset,
	defaultSandboxedShellGateConfig,
	describeRule,
	evaluateRule,
	AuthorizationGate,
} from './authorization/index.js'

// The one reader of a bash command line the gate itself uses. A host that
// writes a `predicate` rule about what a line runs decides on this reading,
// so its rule and the SDK's own never disagree about where a quote ends.
// `nestedShellCommand` says which `-c` payloads that reading already
// includes, so a host treats every other text a program runs as unread.
export {
	NESTED_SHELLS,
	lexShellCommandLine,
	nestedShellCommand,
} from './authorization/shell-lexer.js'

// Where a command line actually execs a program — unwrapping `sudo`, `env`,
// `nice`, `timeout` and the rest of a re-exec chain with their own real
// option grammars, rather than assuming the program sits right after the
// wrapper's name. The live `bash` tool's escalation, the CLI's
// scheduled-run floor and its script check all read this the same way, so
// `env $(echo git) push` and `timeout 5 $(echo systemctl) stop …` cannot be
// verified by one and missed by another.
export {
	DYNAMIC_RESOLUTION_VARIABLES,
	hasPoisoningPrefix,
	poisonedProgramPosition,
	poisonsLaterCommands,
	programPositions,
	resolveScriptPrograms,
	unknownProgramInLine,
} from './authorization/program.js'
export type { CommandProgramPositions, ProgramPosition } from './authorization/program.js'

// NZ-BOOT-03: the module-attributed invariant registry. `compaction.ts` and
// `claim-disk.ts` register themselves against the shared `invariants`
// instance at import time (see each file); `namzu doctor` and any host can
// read `invariants.listIds()` to see what this build claims about its own
// live state, which is the whole point — a registry with nothing on it
// would be exactly the kind of declaration this task exists to close.
export {
	createInvariantRegistry,
	InvariantNameCollisionError,
	invariants,
	InvariantRegistry,
	ModuleInvariantError,
} from './invariants/index.js'
export type { InvariantCheck, InvariantOutcome } from './invariants/index.js'

// ─── probe (typed observation AND enforcement over AgentBus + SessionEvent)
//
// This said "typed observation", which was true of `on`/`onAny`/`dispatch`
// and false of `veto`/`queryVeto`: a registered veto handler can deny a
// tool call, and `runtime/query/executor.ts` turns that denial into a
// failed `tool_result` — the third of the three gates on a tool call.
// `ProbeObservation` and `ProbeEnforcement` let a signature say which half
// it needs; `ProbeRegistry` implements both.

export {
	buildProbeContext,
	createProbeRegistry,
	probe,
	ProbeNameCollisionError,
	ProbeRegistry,
	ProbeVetoError,
} from './probe/index.js'
export type { ProbeEnforcement, ProbeObservation } from './probe/index.js'

export { wrapProviderWithProbes } from './provider/instrumentation.js'
export type { ProviderInstrumentationOptions } from './provider/instrumentation.js'
export type { ResolvedProviderCapabilities } from './provider/capabilities.js'
export { collectChatCompletion } from './provider/collect-chat-completion.js'

// Old spellings of renamed exports, still live for one deprecation window.
// The file explains why each is a `const`+`type` pair rather than a
// re-export alias; the short version is that a re-export cannot carry the
// `@deprecated` tag, and the tag is what the public-surface gate reads.

export {
	wrapCredentialProviderWithProbes,
	wrapVaultWithProbes,
} from './vault/instrumentation.js'
export type { VaultInstrumentationOptions } from './vault/instrumentation.js'

// Doctor runtime moved to @namzu/cli in 0.5.0. SDK keeps only the
// protocol types under `types/doctor/` (re-exported via public-types.ts)
// + `LLMProvider.doctorCheck?()` hook on the provider interface.
// Operators run `npx @namzu/cli doctor`; embedded usage lives there too.

// ─── session runtime — explicit named lists, no `export *` ───────────────
// See §1.5 + §4.2 of design.md. Types flow through public-types.ts.

export {
	GitWorktreeDriver,
	parseWorktreeList,
	SharedSessionWorkspace,
	WorkspaceBackendRegistry,
} from './session/workspace/index.js'

export {
	DefaultCapacityValidator,
	DelegationCapacityExceeded,
	executeBroadcastHandoff,
	executeSingleHandoff,
	HandoffLockRejected,
	HandoffVersionConflict,
	NOOP_HANDOFF_SINK,
} from './session/handoff/index.js'

export {
	AGENT_SUMMARY_MAX_CHARS,
	AgentSummaryTooLongError,
	SessionAlreadySummarizedError,
	SessionSummaryMaterializer,
} from './session/summary/index.js'

export {
	ArtifactRefCycleError,
	InterventionDepthExceeded,
	validatePrevArtifactChain,
} from './session/intervention/index.js'

// A session's conversation as SessionMessages, read from its log: what an
// `ArchivalManager` archives for a child session.
export { readSessionMessages } from './session/messages.js'

export {
	ArchivalManager,
	ArchiveNotConfiguredError,
	ArchiveNotFoundError,
	DiskArchiveBackend,
	RETENTION_POLICY_DISABLED,
	SubSessionNotArchivableError,
	SubSessionNotArchivedError,
} from './session/retention/index.js'

// NOTE: `deriveStatus` intentionally NOT re-exported here — it was not part
// of the pre-ses_011 public surface. Consumers needing it import from the
// internal path. Promoting it to public surface requires an explicit
// follow-up session.

export {
	AncestryCycleError,
	ProjectClosedError,
	ProjectNotEmptyError,
	ProjectRootPathTakenError,
	StaleProjectError,
	StaleSessionError,
	StaleTopicError,
	TenantIsolationError,
	TopicArchivedError,
	TopicNotEmptyError,
	WorkspaceBackendError,
} from './session/errors.js'

// ─── store/session runtime — explicit named (types live in public-types.ts)

export {
	DiskSessionStore,
	getAncestry,
	getChildren,
	InMemorySessionStore,
	orderChildren,
} from './store/session/index.js'

// ─── runtime helpers colocated with shapes under `types/` (§1.5) ─────────

export { A2AProtocolError } from './types/a2a/index.js'
export {
	isTerminalActivityStatus,
	resolveActivityTracking,
} from './types/activity/index.js'
export { isTerminalAgentTaskState } from './types/agent/task.js'
export {
	accumulateTokenUsage,
	isTerminalStatus,
} from './types/common/index.js'
export {
	assertComputerUseActionType,
	assertDisplayServer,
} from './types/computer-use/index.js'
export { isConnectorActive } from './types/connector/core.js'
export { CONNECTOR_SCOPE_ORDER } from './types/connector/scope.js'
export { RoutingResponseSchema } from './types/decision/index.js'
export { autoApproveHandler } from './types/hitl/index.js'
export { deriveChildState } from './types/invocation/index.js'
export {
	MEMORY_TYPES,
	assertMemoryStatus,
	assertMemoryType,
	isMemoryType,
} from './types/memory/index.js'
export {
	createAssistantMessage,
	selectAssistantText,
	createProjectInstructionMessage,
	createRuntimeContextMessage,
	createSystemMessage,
	createToolMessage,
	hasNonTextBlocks,
	toToolResultBlocks,
	toolResultToText,
	createUserMessage,
	isProjectInstructionMessageSource,
	isRuntimeContextMessageSource,
	isModelContentOmission,
	MAX_PROJECT_INSTRUCTION_SOURCE_FILES,
	RUNTIME_CONTEXT_MESSAGE_KINDS,
} from './types/message/index.js'
export { isTerminalPlanStatus } from './types/plan/index.js'
export {
	assertPluginContributionType,
	assertPluginHookEvent,
	assertPluginHookResult,
	assertPluginScope,
	assertPluginStatus,
	PluginManifestSchema,
	PluginMCPServerConfigSchema,
	RENAMED_PLUGIN_HOOK_EVENTS,
} from './types/plugin/index.js'
export { toMemoryCandidate } from './types/session/memory-promotion.js'
export { MutationNotApplicableError } from './types/session/fork.js'
export { replayAudit } from './types/session/audit.js'
export {
	assertSandboxEnvironment,
	assertSandboxStatus,
	// A VALUE, not a type: the control list is iterated at runtime by
	// anything reporting which controls a host enforces. `export type *`
	// carried it far enough to type-check and left the import to fail on
	// the first line of the built binary.
	SANDBOX_ENVIRONMENTS,
	SANDBOX_ISOLATION_CONTROLS,
} from './types/sandbox/index.js'
// `SandboxConfigSchema` is already re-exported above from `./config/runtime.js`
// (the project-wide config barrel surfaces it first). types/sandbox also exports
// one under the same name; `@namzu/sdk` root barrel exposes one symbol — the
// config/runtime version is the canonical path. Keep it out of this block.
export { assertTaskStatus, isTerminalTaskStatus } from './types/task/index.js'
// NOTE: `AuthorizationRuleSchema` and `AuthorizationGateConfigSchema` are NOT
// re-exported — they were not part of the pre-ses_011 public surface.

// ─── compaction runtime ──────────────────────────────────────────────────

// Compaction a host can ASK for. `runCompactionCheck` was the only entry
// point in the kernel and was exported from nowhere, so a host could not
// offer "compact this conversation", could not shrink an idle session
// between turns, and could not collapse a span it had chosen.
export { compactNow, compactRegion } from './compaction/manual.js'
// A host persisting manual compaction has to recognise the system message on
// resume. Export the identity predicate rather than making every host copy the
// marker string and eventually disagree with the writer.
export { isCompactionMessage } from './compaction/summary.js'
export {
	DEFAULT_SALIENCE_CONFIG,
	DEFAULT_SALIENCE_WEIGHTS,
	buildGoal,
	isStubbedNarration,
	messageText,
	planWorkingSet,
	scoreMessages,
} from './compaction/salience/index.js'
export { DEFAULT_SOFT_TARGET, planSalienceWorkingSet } from './compaction/plan.js'
export {
	CONSOLIDATION_TAG,
	consolidationEntry,
	isConsolidated,
} from './compaction/consolidation.js'
// The sibling state-bearing system message. A host that carries a turn's
// conversation into a fresh query must distinguish this ledger from the fresh
// identity/environment prompt floor without copying its private header string.
export { isWorkingMemoryMessage } from './runtime/query/iteration/phases/working-memory.js'
// Their input and result types, because a function on the public surface whose
// return type is not on it forces every caller to inline the shape or reach for
// `any` — and the first host to try (`@namzu/cli`'s `/compact`) did exactly
// that before this line existed.
export type { CompactNowInput, CompactionResult } from './compaction/manual.js'

export {
	buildVerifiedSummary,
	DEFAULT_ASSUMED_CONTEXT_WINDOW,
	lookupContextWindow,
	resolveContextWindow,
	createConversationManager,
	createSlidingWindowReducer,
	extractFromAssistantMessage,
	extractFromToolCall,
	extractFromToolResult,
	extractFromUserMessage,
	findDanglingMessages,
	findSafeTrimIndex,
	findRetainedIndices,
	NullManager,
	removeDanglingMessages,
	repairToolMessageHistory,
	serializeState,
	SlidingWindowManager,
	StructuredCompactionManager,
	WorkingStateManager,
} from './compaction/index.js'
export type {
	ToolHistoryRepairReport,
	ToolHistoryRepairResult,
} from './compaction/index.js'

// ─── loop control ────────────────────────────────────────────────────────

export { anyOf, hasToolCall, stepCountIs } from './types/session/step.js'

// ─── evaluation harness ──────────────────────────────────────────────────

export {
	compareHarnessTrials,
	reviewHarnessCandidate,
	completionScorer,
	containsScorer,
	customScorer,
	evalTurnFromQuery,
	evalTurnFromTurn,
	formatReport,
	judgeScorer,
	runExperiment,
	stepBudgetScorer,
	trajectoryScorer,
} from './eval/index.js'

// ─── metrics ─────────────────────────────────────────────────────────────
//
// Exported so a host can record its own measurements onto the same series
// the runtime uses, rather than defining a parallel set under different
// names that never aggregate.

export {
	recordModelDuration,
	recordTokenUsage,
	recordTurnDuration,
	recordToolCall,
	resetRuntimeMetrics,
} from './telemetry/metrics.js'
export type { TokenUsageSample } from './telemetry/metrics.js'

// ─── guardrails ──────────────────────────────────────────────────────────

export {
	promptInjectionGuardrail,
	secretRedactionGuardrail,
	toolResultCorrespondenceGuardrail,
	toolResultInjectionGuardrail,
} from './runtime/query/guardrail-presets.js'
// Which names a `passthroughTools` list has to contain for a given tool. A
// caller that REPORTS on such a list — the CLI checks an operator's names
// against the tools its registry actually holds, so a name that matches
// nothing is said out loud rather than silently ignored — has to derive them
// the way the screen does rather than keep a second copy of the rule: a name
// the reporter accepts and the screen does not is an exemption the operator
// believes is in force.
export { passthroughToolNames } from './runtime/query/guardrail-presets.js'
// What a turn installs when its host configured no screens. Exported because a
// caller who wants to keep the default AND add to it has to be able to name
// it: `[...DEFAULT_TOOL_RESULT_GUARDRAILS, myScreen()]`.
export { DEFAULT_TOOL_RESULT_GUARDRAILS } from './runtime/query/guardrail-presets.js'
// Thrown by a tool-result screen that returned `halt`. Exported because a
// host has to be able to tell it from an ordinary failure — that is the
// entire difference between the two refusal outcomes.
// Nothing in the kernel calls this: the consumer is a host's own HTTP
// route, and a kernel with no UI and no hosted service has no in-process
// caller to offer. Exported rather than deleted because the reader it was
// written for is out of process by construction.
export { coalesce } from './streaming/coalesce.js'

export { ToolResultHalted } from './registry/tool/screen.js'

// Error taxonomy. `toPlatformError` is the load-bearing one: it normalizes
// ANYTHING thrown into the declared `PlatformError` shape, so a host writes
// one handler instead of an `instanceof` ladder per call site.
export {
	NamzuError,
	isNamzuError,
	toPlatformError,
} from './types/errors/index.js'
// The remediation layer above it: classification says what KIND of failure
// it is, the catalog says what a person should do about it. Separate on
// purpose — the first is structural and belongs at the boundary, the second
// is editorial and belongs in a list a human appends to.
export {
	DEFAULT_ERROR_RULES,
	explainError,
	factsOf,
	readHint,
	withHint,
} from './types/errors/catalog.js'
export type {
	ErrorCatalogRule,
	ErrorExplanation,
	ErrorFacts,
} from './types/errors/catalog.js'

// The box itself is built by `query` — a host receives it through
// `onApprovalPolicy` rather than constructing one, because changing the
// policy appends a durable record and only the turn holds the log. The name
// constant is exported so a host can recognise the unattended default.
export { AUTO_APPROVE_POLICY_NAME } from './runtime/query/approval-policy.js'
// The modes a host resolves the undecided under — prompt, auto,
// accept-edits, plan, strict — as an `ApprovalPolicy`. See
// `runtime/query/review-policy.ts`.
export {
	ACCEPT_EDITS_TOOLS,
	OUTSIDE_ROOTS_UNATTENDED_REFUSAL,
	PLAN_MODE_REFUSAL,
	REVIEW_EXEMPT_WRITES,
	REVIEW_MODES,
	SANDBOX_ESCAPE_UNATTENDED_REFUSAL,
	SCREEN_CONSENT_DECLINED_FEEDBACK,
	SCREEN_CONSENT_UNATTENDED_REFUSAL,
	STRICT_MODE_REFUSAL,
	batchNeedsReview,
	createReviewHandler,
	createReviewPolicy,
	isReviewExempt,
	isReviewMode,
} from './runtime/query/review-policy.js'
// What the model is told when a person declines a call without words of their own.
export { DECLINED_TOOL_CALL_FEEDBACK } from './runtime/query/declined.js'

// The system prompt is open: a contribution registry the assembler
// consumes, with skills as its first contributor. See `prompt/contributions.ts`.
export {
	CODING_AGENT_DELEGATION_DOCTRINE,
	CODING_AGENT_DOCTRINE_CONTRIBUTION_ID,
	CODING_AGENT_ORCHESTRATE_DOCTRINE,
	CODING_AGENT_WORKING_DOCTRINE,
	PLAN_MODE_DOCTRINE,
	PromptContributionCollisionError,
	PromptContributionRegistry,
	SKILLS_CONTRIBUTION_ID,
	codingAgentDoctrineContribution,
	createResidentStepContributions,
	createResidentStepContext,
	skillsContribution,
} from './prompt/index.js'

// Who may reach for a skill. Runtime, not types: `public-types.ts` does
// `export type *` from the same module, which carries the union and leaves
// the resolver and the predicate behind — a consumer could name the policy
// and not ask about it.
export {
	SKILL_INVOCATION_DEFAULT,
	isInvocableBy,
	skillInvocation,
} from './types/skills/index.js'

// Reaching the web. Fetching ships guarded because its rules are about the
// network and the same everywhere; searching ships with no vendor, because
// choosing one here would choose it for every consumer.
export {
	GuardedFetchProvider,
	WebFetchRefusedError,
	isPrivateAddress,
} from './connector/web/index.js'

// Where an attachment's bytes live when the message does not carry them.
// Inline base64 lands in the transcript, in every checkpoint, and on the
// wire once per turn; a reference does not.
export {
	DEFAULT_ATTACHMENT_RESOLVE_TIMEOUT_MS,
	AttachmentMediaTypeMismatchError,
	AttachmentNotFoundError,
	AttachmentResolutionTimeoutError,
	NoAttachmentStoreError,
	isStoredAttachment,
	resolveAttachment,
	resolveAttachments,
} from './store/attachment/index.js'

// Derived values, maintained from the session's own log rather than
// recomputed by whoever asks. See `read-model/registry.ts`.
export {
	DuplicateEventError,
	EventGapError,
	ReadModelCollisionError,
	ReadModelRegistry,
	SESSION_STATUS_READ_MODEL_ID,
	UnknownReadModelError,
	createSessionStatusReadModel,
} from './read-model/index.js'

// Asking a session what happened, including what compaction removed.
export { SessionQuery, SessionTranscriptUnavailableError } from './session-query/index.js'

// A host-scoped pseudo-terminal primitive, or a refusal that names the
// binding to install. It neither creates a sandbox nor owns a descendant
// process tree; a terminal backend supplies those guarantees. A pipe is not
// a terminal, and substituting one is the failure this refuses — see
// `sandbox/terminal.ts`.
export {
	PTY_SPECIFIER,
	TerminalUnavailableError,
	loadPty,
	openTerminalWith,
} from './sandbox/terminal.js'

// ─── types named by exported signatures ──────────────────────────────────
//
// Completing a surface that was already half-exposed. Each of these is the
// parameter or the result of a function exported above, and none of them was
// reachable — so a consumer could CALL the function and could not name what
// they passed or what came back. They inlined the shape or reached for `any`,
// and the package's vocabulary stopped at the function name.
//
// Found by `check-signature-types-exported.mjs`, which exists because the same
// defect was hit three times in two days by whoever happened to write the first
// consumer (`SpanProcessorLike`, then `CompactNowInput` and `CompactionResult`).
// The gate is the reason this is a list rather than a fourth accident.
export type { ResolvedContextWindow } from './compaction/context-window.js'
export type { CompactRegionInput } from './compaction/manual.js'
export type {
	CompactionVerificationOptions,
	UsageSink,
} from './compaction/verifier.js'
export type {
	PluginDiscoveryOptions,
	PluginEnablementCapabilities,
} from './plugin/loader.js'
export type { ProbeContextInput } from './probe/context.js'
export type {
	GoalCommandScope,
	KernelCommandOptions,
} from './registry/command/kernel-commands.js'
export type { ToolCatalogFromRegistryOptions } from './registry/toolset/catalog.js'
export type { MockBidiScript, MockBidiSession } from './runtime/bidi/mock.js'
export type { BidiTurn, BidiTurnParams } from './runtime/bidi/session.js'
export type { SecretRedactionOptions } from './runtime/query/guardrail-presets.js'
export type { ToolResultCorrespondenceOptions } from './runtime/query/guardrail-presets.js'
export type { ListCheckpointsInput } from './runtime/query/fork/list.js'
export type {
	PrepareForkInput,
	PreparedForkState,
} from './runtime/query/fork/prepare.js'
export type {
	HandoffAssignment,
	HandoffOutcome,
} from './session/handoff/assignment.js'
export type { BroadcastHandoffDeps } from './session/handoff/broadcast.js'
export type { SingleHandoffDeps } from './session/handoff/single.js'
export type { InterventionChainLoader } from './session/intervention/prev-artifact.js'
export type {
	ActionInput,
	ComputerUseTool,
	ComputerUseToolOptions,
	ImageSize,
	ScreenshotLimits,
} from './tools/builtins/computer-use.js'
export type { Project } from './types/project/entity.js'
export type { CreatedLogger } from './utils/log/create-logger.js'
export type {
	LoggerOptions,
	MutableLogSinkCounters,
} from './utils/log/types.js'
export type { JobProcess } from './runtime/jobs/registry.js'
export { WORKING_STATE_MIME } from './connector/mcp/adapter.js'

export { snapshotRequestContext, diffRequestContext } from './runtime/query/request-context.js'

export { DiskResidentStore, ResidentConflictError } from './manager/resident/store.js'
export { runResident, stepResident } from './manager/resident/loop.js'
export { DiskResidentAgenda } from './manager/resident/agenda.js'
export { inspectResidentConsumption } from './manager/resident/consumption.js'
export { ResidentHost } from './manager/resident/host.js'

export { createResidentSelector } from './manager/resident/initiative.js'
export { validateResidentProposal } from './manager/resident/proposal.js'

export { deliverResidentMessage } from './manager/resident/outbox.js'
export { createResidentDeliveryWindow } from './manager/resident/delivery-window.js'

export { hashResidentSkill, projectResidentLearning } from './manager/resident/learning.js'
export { runResidentLearningCycle } from './manager/resident/learning-cycle.js'

export {
	createSessionEvidenceSource,
	createSessionTextEvidenceSource,
} from './store/evidence/disk.js'
export { classifyEvidenceSource, EVIDENCE_RECORD_GUIDANCE } from './store/evidence/source-kind.js'
export { createResidentToolEvidenceSource } from './manager/resident/tool-evidence.js'

export { createResidentEvidenceRecallStep } from './manager/resident/evidence-recall.js'

export {
	SqliteResidentLearningStore,
	runStoredResidentLearningCycle,
	runStoredResidentLearningFromObservations,
} from './manager/resident/learning-store.js'

// ─── sessions, turns and the session log ─────────────────────────────────
//
// The session → turn → message model. The record schema is described in
// docs/sdk/session-log.md.

export {
	TurnInProgressError,
	isTurnInProgressError,
} from './types/session/turn.js'
export {
	EPHEMERAL_EVENT_TYPES as EPHEMERAL_SESSION_EVENT_TYPES,
	isEphemeralEvent,
} from './types/session/events.js'
export {
	ChildSessionMetaSchema,
	CompactionRecordSchema,
	ExternalRefSchema,
	MessageRecordSchema,
	MessageReplacedRecordSchema,
	OriginSchema,
	PERSISTED_SESSION_EVENT_TYPES,
	ProjectDocumentSchema,
	RecordPointerSchema,
	SESSION_EVENT_TYPES,
	SESSION_RECORD_MAX_BYTES,
	SESSION_RECORD_SCHEMA_VERSION,
	SESSION_RECORD_TYPES,
	SessionLeaseDocumentSchema,
	SessionRecordSchema,
	SessionStartedRecordSchema,
	TurnCompletedRecordSchema,
	TurnFailedRecordSchema,
	TurnSettlementSchema,
	TurnStartedRecordSchema,
	parseSessionRecord,
} from './types/session/records.js'
export {
	CHECKPOINT_DOCUMENT_VERSION,
	CheckpointDocumentError,
	CheckpointSchema,
	parseCheckpoint,
} from './types/session/checkpoint.js'
export { NamzuHomeError, resolveNamzuHome } from './session/home.js'
export {
	ProjectDocumentError,
	SessionPathError,
	SessionPaths,
	ensureProject,
	hashedSlugForCwd,
	slugForCwd,
	tempRoot,
} from './session/paths.js'
export {
	SessionLogLineError,
	formatSessionLogLine,
	parseSessionLogLine,
	recordSha256,
} from './session/log-hash.js'
export {
	asRecordId,
	asTurnId,
	generateRecordId,
	generateTurnId,
} from './utils/id.js'
export * from './store/session-log/index.js'
export * from './store/session-index/index.js'
export * from './store/checkpoint/index.js'
export * from './store/budget/index.js'
export * from './contracts/session/index.js'
