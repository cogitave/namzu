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

export { ConfigNamespaceCollisionError, ConfigRegistry } from './config/registry.js'
export type { ConfigRegistryOptions, ConfigScope } from './config/registry.js'
export {
	DiskConfigOverrideStore,
	InMemoryConfigOverrideStore,
} from './store/config/index.js'
export type { ConfigOverrideStore } from './store/config/index.js'
export { MCPReconnectOptionsSchema, MCPReconnectSupervisor } from './connector/mcp/reconnect.js'
export type { MCPReconnectOptions, MCPReconnectPolicySource } from './connector/mcp/reconnect.js'

export type {
	CodeNavigationProvider,
	CodeNavigationResult,
	HoverResult,
	SourceLocation,
	SymbolLocation,
	SymbolSearchResult,
} from './types/code-navigation/index.js'

// ─── wire schemas + a2a (contracts/) ─────────────────────────────────────

export {
	CreateMessageSchema,
	CreateRunSchema,
	CreateStatelessRunSchema,
	MessageIdSchema,
	PaginationSchema,
	ProjectIdSchema,
	RunConfigSchema,
	RunIdSchema,
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
export { normaliseModelId, resolveModelPricing, VENDOR_RATES } from './pricing/index.js'
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

// A cancellation carries its origin now; these are what a host reads it
// with.  is exported alongside the class because a host
// implementing its own gateway holds an abort REASON, not a RunCancelled.
export { cancelCauseOf, RunCancelled } from './types/run/cancel-cause.js'

// A tool authors how it is shown; a host resolves through this rather than
// switching on a lowercased tool name, which is what left every MCP and
// plugin tool with a truncated string no matter what it did.
// Credential resolution as a seam. All provider credential discovery lived
// in the CLI, so a host embedding the SDK alone had no way to plug in an
// env- or file-backed source without reimplementing an interface that asks
// a different question.
// The collaboration mode, durable per Topic. It was resolved once per run
// and copied into the executor, so leaving plan mode meant ending the run
// and discarding the in-flight step to change one enum.
// The object a host holds between runs. There was none: no way to ask
// whether the agent is running, and nowhere to put "when you next run,
// start with this".
export { AgentNotRunningError, createAgentHandle } from './agents/handle.js'

export {
	DiskTopicStateStore,
	InMemoryTopicStateStore,
} from './store/topic/state.js'
export { StaleTopicStateError } from './types/topic/state.js'

// Work that outlives one run. Named explicitly here rather than reached
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

export { createToolPresenter, genericLabel } from './registry/tool/presentation.js'
export type { ToolPresenter } from './registry/tool/presentation.js'

// A stalled stream trips no request timeout — the request succeeded and
// the bytes stopped. Composes with withProviderRetry/withProviderFallback:
// the failure is classified `network`, which both already act on.
// One header, so a vendor reading its own logs can tell a kernel's traffic
// from a browser's — and so an abuse or rate-limit investigation lands on
// the right party.
export { NAMZU_APP_IDENTITY, attributionHeaders } from './provider/attribution.js'
export type { AppIdentity } from './provider/attribution.js'

export { DEFAULT_STREAM_IDLE_TIMEOUT_MS, withStreamIdleTimeout } from './provider/idle-timeout.js'
export type { WithStreamIdleTimeoutOptions } from './provider/idle-timeout.js'

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

// ─── router, runtime, run ────────────────────────────────────────────────

export { resolveTaskModel } from './model-router/task-router.js'
// Every driver accepts `thinking`; one that does not implement it must
// refuse rather than drop it. Shared so a new driver inherits the rule.
export { assertThinkingUnsupported } from './provider/thinking-support.js'
// One matcher for versioned model ids. Shared because three drivers had each
// written their own and all three read an 8-digit date suffix as the MINOR
// version, which inverted every capability decision keyed on it. The shape
// lives here; the vocabulary comes from the driver that knows it.
export { modelVersionAtLeast, parseVersionedModelId } from './provider/model-version.js'
// Strict tool input is a SUBSET of JSON Schema, and a keyword outside it makes
// the vendor reject the whole request rather than degrade one field.
export { assertStrictSchema, findStrictSchemaViolations } from './provider/strict-schema.js'
// A tool has one schema; what changes per provider is the DIALECT the wire
// parses, which is the wire's property. Rendered once, converted at the driver.
export { findDraft07Only, toSchemaDialect } from './registry/tool/dialect.js'
export type { JsonSchemaDialect } from './registry/tool/dialect.js'
// The renderer itself, so a driver or a contract test can ask what a tool will
// actually put on the wire without reaching into the registry.
export { renderToolSchema } from './registry/tool/schema.js'
export type { StrictSchemaViolation } from './provider/strict-schema.js'
export type { ModelIdGrammar, ModelVersion } from './provider/model-version.js'
export { drainQuery, query } from './runtime/query/index.js'
// Mid-run guidance. A host holds the channel and the loop drains it at the
// tool-result boundary; see the module for why that is the only legal slot.
export { SteeringBinding, attachSteering, formatSteeringNote } from './runtime/query/steering.js'
export type { SteeringChannel } from './runtime/query/steering.js'
export { createMockBidiProvider, startBidiRun } from './runtime/bidi/index.js'
export { PromptCache } from './runtime/query/prompt-cache.js'
export {
	CheckpointManager,
	findPendingCheckpoint,
	isExpiredPark,
	listExpiredParks,
	projectEmergencyToCheckpoint,
} from './runtime/query/checkpoint.js'
// Projecting what the SDK records onto the session-layer statuses. Both
// were declared and consumed with nothing in the repo producing them, so a
// host implementing either had to invent the mapping.
export { deriveRunStatus } from './types/run/derive-status.js'
// Scoped approval memory: the mechanism that lets an approver choose how
// wide their yes is, instead of choosing between 'this one call' and
// 'everything for the session'.
export { ToolGrantSet, toolGrantKeys } from './runtime/query/tool-grants.js'
export type { ToolGrantKeys } from './runtime/query/tool-grants.js'
export { toWireRunStatus } from './contracts/run-status.js'
// Durable run state: the snapshot a different process picks a run up from.
export { captureRunState, loadRunState } from './runtime/query/run-state.js'
// …and the driver that joins the snapshot back to a running loop. Without
// it every host wrote the same wiring, and in practice none did.
export { resumeRun } from './runtime/query/resume-run.js'
export type { ResumeOutcome, ResumeRunParams } from './runtime/query/resume-run.js'
// The scope type was internal, so a host calling `loadRunState` could not
// name the argument it had to construct.
export type { RunStateScope } from './runtime/query/run-state.js'
export { prepareReplayState } from './runtime/query/replay/prepare.js'
export { listCheckpoints } from './runtime/query/replay/list.js'
export { DecisionParser, FallbackResolver } from './runtime/decision/index.js'
export {
	buildLimitConfig,
	checkLimitsDetailed,
	createRunReporter,
} from './run/index.js'
// One bounded pass over a queue of durable runs: list what nobody holds,
// claim it, work it, release it in a `finally`. Every primitive it composes
// already shipped and nothing composed them, so an approval inbox and a
// crash sweeper each still needed a host to write the loop — including the
// two parts a host writes wrong, the release on the failure path and the
// `null` claim that is not one. Not a daemon: it makes one pass and returns.
export { DEFAULT_DRAIN_PAGE_SIZE, drainRuns } from './run/index.js'
export type {
	DrainFailure,
	DrainRun,
	DrainRunsParams,
	DrainRunsResult,
} from './run/index.js'
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
	fingerprintWorkspace,
} from './run/index.js'
export type {
	CommandGateOptions,
	FingerprintExec,
	GateExec,
	WorkspaceFingerprintOptions,
} from './run/index.js'
// The default `promoteMemory`: write what a run learned into a MemoryStore,
// or write NOTHING. The hook was invoked at settle with the compaction
// extractor's already-structured output and no shipped app supplied it, so
// that structure was serialized into one system message and dropped when
// the run ended. A run that learned nothing leaves no record at all — the
// model reads this store, so noise here is context spent on a run that did
// nothing.
export { RUN_MEMORY_TAG, createMemoryPromoter } from './run/index.js'
export type { MemoryPromoterOptions } from './run/index.js'

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
	deriveRunOptions,
	deriveSupervisorOptions,
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
} from './agents/index.js'

// ─── registries, stores, managers, plugin, gateway ───────────────────────

export {
	ActivityStore,
	DiskCheckpointStore,
	DiskMemoryStore,
	DiskTaskStore,
	InMemoryCheckpointStore,
	InMemoryMemoryIndex,
	InMemoryRunStore,
	InMemoryMemoryStore,
	InMemoryStore,
	InMemoryTaskStore,
	RunDiskStore,
} from './store/index.js'
export type { DiskCheckpointStoreAttribution } from './store/index.js'
// Enumerating runs above a run id — the read an approval inbox and a park
// sweep are built from, and the one the contract had no way to express.
// `listDurableRuns` REFUSES on a store that cannot list rather than
// reporting an empty page, because "nothing is waiting on a human" is not
// what "I cannot tell" means.
export {
	assertContiguousListingScope,
	listDurableRuns,
	paginateDurableRuns,
	toDurableRunEntry,
} from './store/index.js'
// Cross-process possession of a run. `claimRun` REFUSES on a store that
// cannot arbitrate rather than proceeding unclaimed, because proceeding lets
// two workers restore one checkpoint, both run its tools and both write under
// one run id — which loses half the work and reports nothing.
export { claimRun, fencedOut, releaseRun, toClaimSummary } from './store/index.js'
// Reading a run's durable event log back — what a consumer that lost its
// connection catches up through. `readRunEventsIn` takes a directory rather
// than a bound store because binding one CREATES the run directory, and a read
// that mints an empty run then reports it as having no events is worse than an
// error. `resolveRunEventReplay` decides what a cursor is owed, and REFUSES
// rather than delivering a partial catch-up a consumer would fold into its
// state without knowing it had a hole in it.
// Walking the actor chain — exported so the next cross-tree concern (an
// audit over a subtree, a host asking whether one run is contained by
// another) composes with the chain that is already persisted, rather than
// building a second parent registry beside it.
export { actorChain, isDescendantOfActor, MAX_ACTOR_CHAIN_DEPTH } from './session/actor-scope.js'
export { readRunEventsIn, readRunMessagesIn } from './store/index.js'
export {
	DiskMessageFeedbackStore,
	InMemoryMessageFeedbackStore,
	StaleFeedbackError,
	UnknownMessageError,
} from './store/feedback/index.js'
export { resolveRunEventReplay } from './types/run/event-cursor.js'

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
	discoverAllPluginDirs,
	discoverPlugins,
	loadPluginManifest,
	PluginLifecycleManager,
	PluginResolver,
} from './plugin/index.js'

export {
	AgentManager,
	EmergencySaveManager,
	PlanManager,
	ProjectManager,
	// The gate itself, not only the manager that wraps it. A host writing its
	// own ingress path — a custom handoff, a queue consumer that creates
	// sessions — needs to refuse a closed workspace without constructing a
	// manager, which is the reason it is a function over a store.
	requireOpenProject,
	RunPersistence,
	TopicManager,
	/**
	 * @deprecated Use {@link TopicManager}. A literal identity re-export, not a
	 * wrapper, so `instanceof` and `===` still hold for callers who have not
	 * migrated. Removal is NZ-TOPIC-05 -- NZ-TOPIC-01 marked it deprecated but
	 * that release never reached npm, so this major is the first one a consumer
	 * can actually see the warning in.
	 */
} from './manager/index.js'

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
export { CompletionInbox, formatCompletionNotification } from './scheduler/completion-inbox.js'

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
} from './sandbox/index.js'
export type { LocalSandboxProviderOptions } from './sandbox/index.js'

// The classified provider-failure surface: a driver states what went wrong
// first-hand, and the run boundary reads it to choose between a pause and a
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
	LocalExecutionContext,
	MCPClient,
	MCPMethodNotFound,
	MCPConnectorBridge,
	MCPServer,
	MCPToolDiscovery,
	mcpPromptToToolDefinition,
	renderPromptMessages,
	mcpJsonSchemaToZod,
	mcpToolResultToToolResult,
	mcpToolToToolDefinition,
	RemoteExecutionContext,
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
	WebhookConnector,
	zodToMCPJsonSchema,
} from './connector/index.js'
export type {
	MCPToolDiscoveryOptions,
	MCPToolDrift,
	MCPToolPolicy,
	MCPToolPolicyDecision,
} from './connector/index.js'

// ─── bridges (a2a + sse) ─────────────────────────────────────────────────

export {
	a2aMessageToCreateRun,
	a2aMessageToInput,
	buildAgentCard,
	extractTextFromA2AMessage,
	isTerminalState,
	mapRunToA2AEvent,
	mapSessionToA2AEvent,
	messageToA2A,
	runStatusToA2AState,
	runToA2ATask,
} from './bridge/a2a/index.js'

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
export type { A2ADelegateConfig, FetchLike } from './bridge/a2a/client.js'

export {
	mapRunToStreamEvent,
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

// ─── probe (typed observation AND enforcement over AgentBus + RunEvent) ──
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

export { RUN_EVENT_SCHEMA_VERSION } from './session/events/index.js'

export {
	DefaultPathBuilder,
	GitWorktreeDriver,
	parseWorktreeList,
	SharedRunWorkspace,
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

export {
	acceptLegacyContainerId,
	/** @deprecated Use {@link acceptLegacyContainerId}. Removal is NZ-TOPIC-05. */
	acquireMigrationLock,
	DefaultFilesystemMigrator,
	FilesystemMigrationError,
	LEGACY_DEFAULT_PROJECT_PREFIX,
	LEGACY_DEFAULT_SESSION_ID,
	LOCK_REL_PATH,
	loggingMigrationSink,
	MARKER_REL_PATH,
	MIGRATION_VERSION,
	NOOP_FILESYSTEM_MIGRATION_SINK,
	NOOP_MIGRATION_WARNING_SINK,
	readMarker,
	rejectLegacyContainerPrefix,
	/** @deprecated Use {@link rejectLegacyContainerPrefix}. Removal is NZ-TOPIC-05. */
	releaseMigrationLock,
	StalePrefixError,
	WINDOW_OPEN,
	writeMarker,
} from './session/migration/index.js'

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
	// Exported, unlike `ThreadClosedError`, because a host that closes a
	// workspace has to be able to tell "this workspace is closed" from any
	// other spawn failure — and matching on a message string is not a
	// contract. The comment below is the reason; these are the first three
	// that take it seriously.
	ProjectClosedError,
	ProjectNotEmptyError,
	ProjectRootPathTakenError,
	StaleProjectError,
	// Exported with the CAS it announces. A host that opts into
	// `expectedOwnerVersion` has to be able to tell "somebody else took this
	// session" from any other failure, and string-matching a message is not a
	// contract — which is the state `ThreadClosedError` and its siblings are
	// still in, and a reason not to add a fourth.
	StaleSessionError,
	TenantIsolationError,
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
export { UNKNOWN_TENANT_ID } from './types/ids/index.js'
export { deriveChildState } from './types/invocation/index.js'
export { assertMemoryStatus } from './types/memory/index.js'
export {
	createAssistantMessage,
	createSystemMessage,
	createToolMessage,
	hasNonTextBlocks,
	toToolResultBlocks,
	toolResultToText,
	createUserMessage,
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
} from './types/plugin/index.js'
export { EmergencySaveConfigSchema } from './types/run/emergency.js'
export { toMemoryCandidate } from './types/run/memory-promotion.js'
export { MutationNotApplicableError } from './types/run/replay.js'
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
	serializeState,
	SlidingWindowManager,
	StructuredCompactionManager,
	WorkingStateManager,
} from './compaction/index.js'

// ─── loop control ────────────────────────────────────────────────────────

export { anyOf, hasToolCall, stepCountIs } from './types/run/step.js'

// ─── evaluation harness ──────────────────────────────────────────────────

export {
	completionScorer,
	containsScorer,
	customScorer,
	evalRunFromQuery,
	evalRunFromRun,
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
	recordRunDuration,
	recordTokenUsage,
	recordToolCall,
	resetRuntimeMetrics,
} from './telemetry/metrics.js'
export type { TokenUsageSample } from './telemetry/metrics.js'

// ─── guardrails ──────────────────────────────────────────────────────────

export {
	promptInjectionGuardrail,
	secretRedactionGuardrail,
	toolResultInjectionGuardrail,
} from './runtime/query/guardrail-presets.js'
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
export { NamzuError, isNamzuError, toPlatformError } from './types/errors/index.js'
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
export type { ErrorCatalogRule, ErrorExplanation, ErrorFacts } from './types/errors/catalog.js'

// The box itself is built by `query` — a host receives it through
// `onApprovalPolicy` rather than constructing one, because changing the
// policy emits a durable event and only the run holds the emitter. The name
// constant is exported so a host can recognise the unattended default.
export { AUTO_APPROVE_POLICY_NAME } from './runtime/query/approval-policy.js'

// The system prompt is open: a contribution registry the assembler
// consumes, with skills as its first contributor. See `prompt/contributions.ts`.
export {
	PromptContributionCollisionError,
	PromptContributionRegistry,
	SKILLS_CONTRIBUTION_ID,
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
	AttachmentMediaTypeMismatchError,
	AttachmentNotFoundError,
	NoAttachmentStoreError,
	isStoredAttachment,
	resolveAttachment,
	resolveAttachments,
} from './store/attachment/index.js'

// Derived values, maintained from the run's own event log rather than
// recomputed by whoever asks. See `read-model/registry.ts`.
export {
	DuplicateEventError,
	EventGapError,
	RUN_STATUS_READ_MODEL_ID,
	ReadModelCollisionError,
	ReadModelRegistry,
	UnknownReadModelError,
	createRunStatusReadModel,
} from './read-model/index.js'

// Asking a finished run what happened, including what compaction removed.
// `compaction_shed` has carried the removed messages since NZ-RUNREC-06 and
// nothing read them back; evidence nobody can retrieve is evidence nobody
// kept.
export { RunQuery, RunTranscriptUnavailableError } from './run-query/index.js'

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
export type { UsageSink } from './compaction/verifier.js'
export type { PluginDiscoveryOptions } from './plugin/loader.js'
export type { ProbeContextInput } from './probe/context.js'
export type {
	GoalCommandScope,
	KernelCommandOptions,
} from './registry/command/kernel-commands.js'
export type { ToolCatalogFromRegistryOptions } from './registry/toolset/catalog.js'
export type { MockBidiScript, MockBidiSession } from './runtime/bidi/mock.js'
export type { BidiRun, BidiRunParams } from './runtime/bidi/session.js'
export type { SecretRedactionOptions } from './runtime/query/guardrail-presets.js'
export type { ListCheckpointsInput } from './runtime/query/replay/list.js'
export type { PrepareReplayInput, PreparedReplayState } from './runtime/query/replay/prepare.js'
export type { HandoffAssignment, HandoffOutcome } from './session/handoff/assignment.js'
export type { BroadcastHandoffDeps } from './session/handoff/broadcast.js'
export type { SingleHandoffDeps } from './session/handoff/single.js'
export type { InterventionChainLoader } from './session/intervention/prev-artifact.js'
export type { FilesystemMigrationSink } from './session/migration/filesystem.js'
export type { MigrationWarningSink } from './session/migration/id-prefix.js'
export type { MigrationMarker } from './session/migration/marker.js'
export type { ActionInput } from './tools/builtins/computer-use.js'
export type { Project } from './types/project/entity.js'
export type { CreatedLogger } from './utils/log/create-logger.js'
export type { LoggerOptions, MutableLogSinkCounters } from './utils/log/types.js'
