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

export { accumulateCost, calculateCost, formatCost, ZERO_COST } from './utils/cost.js'
export { toErrorMessage } from './utils/error.js'
export { configureLogger, getRootLogger, Logger } from './utils/logger.js'
export { buildToolResultHashes, hashToolResult } from './utils/hash.js'
export { compressShellOutput, compressShellOutputFull } from './utils/shell-compress.js'
export { createChildAbortController } from './utils/abort.js'
export { memoizeAsync } from './utils/memoize.js'
export { extractFinalResponse } from './utils/conversation.js'

// ─── router, runtime, run ────────────────────────────────────────────────

export { resolveTaskModel } from './router/task-router.js'
export { drainQuery, query } from './runtime/query/index.js'
export { ContextCache } from './runtime/query/context-cache.js'
export { CheckpointManager, projectEmergencyToCheckpoint } from './runtime/query/checkpoint.js'
export { prepareReplayState } from './runtime/query/replay/prepare.js'
export { listCheckpoints } from './runtime/query/replay/list.js'
export { DecisionParser, FallbackResolver } from './runtime/decision/index.js'
export {
	buildLimitConfig,
	checkLimitsDetailed,
	createRunReporter,
} from './run/index.js'

// ─── personas, skills, advisory ──────────────────────────────────────────

export { assembleSystemPrompt, mergePersonas, withSessionContext } from './persona/index.js'
export { discoverSkills, loadSkill, resolveSkillChain, SkillRegistry } from './skills/index.js'
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
	SupervisorAgent,
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
	RunDiskStore,
} from './store/index.js'

export {
	AgentRegistry,
	ManagedRegistry,
	PluginRegistry,
	Registry,
	ToolRegistry,
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
} from './manager/index.js'

export { LocalTaskGateway } from './gateway/local.js'

// ─── providers, sandbox, vault ───────────────────────────────────────────

export {
	DuplicateProviderError,
	MOCK_CAPABILITIES,
	MockLLMProvider,
	ProviderRegistry,
	registerMock,
	UnknownProviderError,
} from './provider/index.js'

export { LocalSandboxProvider, SandboxProviderFactory } from './sandbox/index.js'

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
	OpenRouterEmbeddingProvider,
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
	MCPConnectorBridge,
	MCPServer,
	MCPToolDiscovery,
	mcpJsonSchemaToZod,
	mcpToolResultToToolResult,
	mcpToolToToolDefinition,
	RemoteExecutionContext,
	ScopedConnectorRegistry,
	StdioTransport,
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

export { mapRunToStreamEvent, mapSessionToStreamEvent } from './bridge/sse/index.js'

// ─── bus, verification ───────────────────────────────────────────────────

export {
	AgentBus,
	CircuitBreaker,
	EditOwnershipTracker,
	FileLockManager,
} from './bus/index.js'

export { evaluateRule, VerificationGate } from './verification/index.js'

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
export { isTerminalActivityStatus, resolveActivityTracking } from './types/activity/index.js'
export { isTerminalAgentTaskState } from './types/agent/task.js'
export { accumulateTokenUsage, isTerminalStatus } from './types/common/index.js'
export { assertComputerUseActionType, assertDisplayServer } from './types/computer-use/index.js'
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
export { MutationNotApplicableError } from './types/run/replay.js'
export {
	assertSandboxEnvironment,
	assertSandboxStatus,
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
	createConversationManager,
	extractFromAssistantMessage,
	extractFromToolCall,
	extractFromToolResult,
	extractFromUserMessage,
	findDanglingMessages,
	findSafeTrimIndex,
	NullManager,
	removeDanglingMessages,
	serializeState,
	SlidingWindowManager,
	StructuredCompactionManager,
	WorkingStateManager,
} from './compaction/index.js'
