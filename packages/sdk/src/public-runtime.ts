// Public runtime surface of `@namzu/sdk`.
//
// Every runtime value a consumer might need: classes (agents, managers,
// stores, registries), functions (helpers, ID generators, runtime entry
// points), zod schemas, constants, error classes. See §4.2 of
// `docs.local/sessions/ses_011-sdk-public-surface/design.md`.
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
	calculateCost,
	formatCost,
	ZERO_COST,
} from './utils/cost.js'
export { toErrorMessage } from './utils/error.js'
export { configureLogger, getRootLogger, Logger } from './utils/logger.js'
export { buildToolResultHashes, hashToolResult } from './utils/hash.js'
export {
	compressShellOutput,
	compressShellOutputFull,
} from './utils/shell-compress.js'
export { createChildAbortController } from './utils/abort.js'
export { memoizeAsync } from './utils/memoize.js'
export { extractFinalResponse } from './utils/conversation.js'

// ─── router, runtime, run ────────────────────────────────────────────────

export { resolveTaskModel } from './router/task-router.js'
// Every driver accepts `thinking`; one that does not implement it must
// refuse rather than drop it. Shared so a new driver inherits the rule.
export { assertThinkingUnsupported } from './provider/thinking-support.js'
// One matcher for Claude model ids. Shared because there were three copies of
// it and all three read an 8-digit date suffix as the MINOR version, which
// inverted every capability decision keyed on it.
export {
	claudeVersionAtLeast,
	parseClaudeModelVersion,
} from './provider/claude-model-version.js'
export type { ClaudeFamily, ClaudeModelVersion } from './provider/claude-model-version.js'
export { drainQuery, query } from './runtime/query/index.js'
// Mid-run guidance. A host holds the channel and the loop drains it at the
// tool-result boundary; see the module for why that is the only legal slot.
export { SteeringBinding, attachSteering, formatSteeringNote } from './runtime/query/steering.js'
export type { SteeringChannel } from './runtime/query/steering.js'
export { createMockBidiProvider, startBidiRun } from './runtime/bidi/index.js'
export { ContextCache } from './runtime/query/context-cache.js'
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
	InMemoryMemoryIndex,
	InMemoryMemoryStore,
	InMemoryStore,
	InMemoryTaskStore,
	RunDiskStore,
} from './store/index.js'

export {
	AgentRegistry,
	ManagedRegistry,
	PluginRegistry,
	Registry,
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
	RunPersistence,
	ThreadManager,
} from './manager/index.js'

export { InMemoryThreadStore } from './store/thread/memory.js'

export { LocalTaskGateway } from './gateway/local.js'

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
	withProviderRetry,
} from './provider/index.js'
export type { ProviderRetryConfig, WithProviderRetryOptions } from './provider/index.js'

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
	StdioTransport,
	StreamableHttpTransport,
	TenantConnectorManager,
	toolDefinitionToMCPTool,
	toolResultToMCPToolResult,
	WebhookConnector,
	zodToMCPJsonSchema,
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

export {
	mapRunToStreamEvent,
	mapSessionToStreamEvent,
} from './bridge/sse/index.js'

// ─── bus, verification ───────────────────────────────────────────────────

export {
	AgentBus,
	CircuitBreaker,
	EditOwnershipTracker,
	FileLockManager,
} from './bus/index.js'

export {
	defaultSandboxedGateConfig,
	defaultSandboxedShellGateConfig,
	evaluateRule,
	VerificationGate,
} from './verification/index.js'

// ─── probe (typed observation over AgentBus + RunEvent stream) ───────────

export {
	buildProbeContext,
	createProbeRegistry,
	probe,
	ProbeNameCollisionError,
	ProbeRegistry,
	ProbeVetoError,
} from './probe/index.js'

export { wrapProviderWithProbes } from './provider/instrumentation.js'
export type { ProviderInstrumentationOptions } from './provider/instrumentation.js'
export type { ResolvedProviderCapabilities } from './provider/capabilities.js'
export { collect } from './provider/collect.js'

export { wrapVaultWithProbes } from './vault/instrumentation.js'
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
	NOOP_RUN_STATUS_RESOLVER,
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
	acceptLegacyThreadId,
	acquireMigrationLock,
	DefaultFilesystemMigrator,
	FilesystemMigrationError,
	LEGACY_DEFAULT_PROJECT_PREFIX,
	LEGACY_DEFAULT_SESSION_ID,
	LOCK_REL_PATH,
	MARKER_REL_PATH,
	MIGRATION_VERSION,
	NOOP_FILESYSTEM_MIGRATION_SINK,
	NOOP_MIGRATION_WARNING_SINK,
	readMarker,
	rejectLegacyPrefix,
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
	SANDBOX_ISOLATION_CONTROLS,
} from './types/sandbox/index.js'
// `SandboxConfigSchema` is already re-exported above from `./config/runtime.js`
// (the project-wide config barrel surfaces it first). types/sandbox also exports
// one under the same name; `@namzu/sdk` root barrel exposes one symbol — the
// config/runtime version is the canonical path. Keep it out of this block.
export { assertTaskStatus, isTerminalTaskStatus } from './types/task/index.js'
// NOTE: `VerificationRuleSchema` and `VerificationGateConfigSchema` are NOT
// re-exported — they were not part of the pre-ses_011 public surface.

// ─── compaction runtime ──────────────────────────────────────────────────

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
} from './runtime/query/guardrail-presets.js'

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
