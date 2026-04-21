// ses_011 public-surface split (2026-04-21). Types come from `public-types.ts`;
// runtime wiring lands in commits 3 (public-runtime.ts) and 4 (public-tools.ts).
// During the migration window, runtime is still routed through the per-module
// `export * from './types/*/index.js'` lines below.
export type * from './public-types.js'

export { VERSION } from './version.js'
export {
	RuntimeConfigSchema,
	TaskRouterConfigSchema,
	CompactionConfigSchema,
	PluginRuntimeConfigSchema,
	SandboxConfigSchema,
	RUNTIME_DEFAULTS,
} from './config/runtime.js'

export * from './constants/index.js'

export * from './contracts/index.js'

export * from './types/ids/index.js'
export * from './types/message/index.js'
export * from './types/common/index.js'
export * from './types/tool/index.js'
export * from './types/permission/index.js'
export * from './types/run/index.js'
export * from './types/provider/index.js'
export * from './types/agent/index.js'
export * from './types/decision/index.js'
export * from './types/persona/index.js'
export * from './types/activity/index.js'
export * from './types/task/index.js'
export * from './types/plan/index.js'
export * from './types/hitl/index.js'
export * from './types/rag/index.js'
export * from './types/execution/index.js'
export * from './types/connector/index.js'
export * from './types/skills/index.js'
export * from './types/a2a/index.js'
export * from './types/router/index.js'
export * from './types/advisory/index.js'
export * from './types/memory/index.js'
export * from './types/plugin/index.js'
export * from './types/sandbox/index.js'
export * from './types/structured-output/index.js'
export * from './types/invocation/index.js'
export * from './types/computer-use/index.js'
// Session hierarchy types now flow through `public-types.ts` (see top).
// Runtime primitives come via `./session/index.js` and `./store/session/index.js` below.

export {
	AdvisorRegistry,
	AdvisoryExecutor,
	TriggerEvaluator,
	AdvisoryContext,
} from './advisory/index.js'
export type {
	AdvisoryCallContext,
	AdvisoryExecutionResult,
} from './advisory/index.js'

export {
	assembleSystemPrompt,
	mergePersonas,
	withSessionContext,
} from './persona/index.js'
export {
	SkillRegistry,
	resolveSkillChain,
	loadSkill,
	discoverSkills,
} from './skills/index.js'

export * from './utils/id.js'
export * from './utils/cost.js'
export * from './utils/error.js'
export * from './utils/logger.js'
export { hashToolResult, buildToolResultHashes } from './utils/hash.js'
export {
	compressShellOutput,
	compressShellOutputFull,
} from './utils/shell-compress.js'
export type {
	ShellCompressResult,
	ShellCompressOptions,
} from './utils/shell-compress.js'
export { createChildAbortController } from './utils/abort.js'
export { memoizeAsync } from './utils/memoize.js'
export { extractFinalResponse } from './utils/conversation.js'

export { resolveTaskModel } from './router/task-router.js'

export { query, drainQuery } from './runtime/query/index.js'
export type { QueryParams } from './runtime/query/index.js'
export { ContextCache } from './runtime/query/context-cache.js'
export type {
	ContextCacheConfig,
	PromptCacheInput,
} from './runtime/query/context-cache.js'
export { CheckpointManager } from './runtime/query/checkpoint.js'
export { DecisionParser, FallbackResolver } from './runtime/decision/index.js'

export {
	createRunReporter,
	type RunReporter,
	checkLimitsDetailed,
	buildLimitConfig,
	type LimitCheckerState,
	type LimitCheckResult,
} from './run/index.js'

export {
	AbstractAgent,
	ReactiveAgent,
	PipelineAgent,
	RouterAgent,
	SupervisorAgent,
	defineAgent,
	InvocationLock,
	ConcurrentInvocationError,
} from './agents/index.js'
export type { DefineAgentOptions, ConcurrencyMode, Disposable } from './agents/index.js'

export {
	InMemoryStore,
	type Identifiable,
	type Timestamped,
	RunDiskStore,
	ActivityStore,
	type ActivityEvent,
	type ActivityEventListener,
	InMemoryTaskStore,
	DiskTaskStore,
	type DiskTaskStoreConfig,
	InMemoryMemoryIndex,
	InMemoryMemoryStore,
	DiskMemoryStore,
	type DiskMemoryStoreConfig,
} from './store/index.js'

export {
	Registry,
	ManagedRegistry,
	type ManagedRegistryConfig,
	AgentRegistry,
	PluginRegistry,
	ToolRegistry,
	type ToolExecutionResult,
} from './registry/index.js'

export {
	PluginLifecycleManager,
	PluginResolver,
	discoverPlugins,
	loadPluginManifest,
	discoverAllPluginDirs,
} from './plugin/index.js'
export type { PluginLifecycleManagerConfig } from './plugin/lifecycle.js'

export {
	RunPersistence,
	EmergencySaveManager,
	PlanManager,
	type PlanEvent,
	type PlanEventListener,
	type PlanApprovalHandler,
	AgentManager,
} from './manager/index.js'

export {
	buildTaskTools,
	buildTaskCreateTool,
	buildTaskUpdateTool,
	buildTaskListTool,
} from './tools/task/index.js'
export { buildAdvisoryTools } from './tools/advisory/index.js'
export type { AdvisoryToolsOptions } from './tools/advisory/index.js'
export { buildMemoryTools } from './tools/memory/index.js'
export { LocalTaskGateway } from './gateway/local.js'

export {
	ProviderRegistry,
	UnknownProviderError,
	DuplicateProviderError,
	MockLLMProvider,
	registerMock,
	MOCK_CAPABILITIES,
} from './provider/index.js'

export {
	LocalSandboxProvider,
	SandboxProviderFactory,
} from './sandbox/index.js'

export { defineTool } from './tools/defineTool.js'
export type { DefineToolOptions } from './tools/defineTool.js'
export { getBuiltinTools } from './tools/builtins/index.js'
export { ReadFileTool } from './tools/builtins/read-file.js'
export { WriteFileTool } from './tools/builtins/write-file.js'
export { EditTool } from './tools/builtins/edit.js'
export { BashTool } from './tools/builtins/bash.js'
export { GlobTool } from './tools/builtins/glob.js'
export { GrepTool } from './tools/builtins/grep.js'
export { LsTool } from './tools/builtins/ls.js'
export { SearchToolsTool } from './tools/builtins/search-tools.js'
export {
	createStructuredOutputTool,
	STRUCTURED_OUTPUT_TOOL_NAME,
} from './tools/builtins/structuredOutput.js'
export {
	createComputerUseTool,
	COMPUTER_USE_TOOL_NAME,
} from './tools/builtins/computer-use.js'

export {
	TextChunker,
	DEFAULT_CHUNKING_CONFIG,
	OpenRouterEmbeddingProvider,
	InMemoryVectorStore,
	cosineSimilarity,
	DefaultRetriever,
	DEFAULT_RETRIEVAL_CONFIG,
	DefaultIngestionPipeline,
	assembleRAGContext,
	DEFAULT_RAG_CONTEXT_CONFIG,
	DefaultKnowledgeBase,
	createRAGTool,
} from './rag/index.js'

export {
	BaseConnector,
	ConnectorRegistry,
	ConnectorManager,
	HttpConnector,
	WebhookConnector,
	ScopedConnectorRegistry,
	TenantConnectorManager,
	EnvironmentConnectorManager,
	BaseExecutionContext,
	LocalExecutionContext,
	RemoteExecutionContext,
	HybridExecutionContext,
	ExecutionContextFactory,
	StdioTransport,
	HttpSseTransport,
	MCPClient,
	mcpToolToToolDefinition,
	toolDefinitionToMCPTool,
	mcpJsonSchemaToZod,
	zodToMCPJsonSchema,
	mcpToolResultToToolResult,
	toolResultToMCPToolResult,
	MCPToolDiscovery,
	MCPConnectorBridge,
	MCPServer,
} from './connector/index.js'
export type {
	ConnectorManagerConfig,
	TenantConnectorManagerConfig,
	EnvironmentConnectorSetup,
	EnvironmentConnectorManagerConfig,
	LocalExecutionContextOptions,
	RemoteExecutionContextOptions,
	HybridExecutionContextOptions,
	MCPServerToolProvider,
	MCPServerResourceProvider,
} from './connector/index.js'

export {
	createConnectorExecuteTool,
	createConnectorListTool,
	createConnectorTools,
	connectorMethodToTool,
	connectorInstanceToTools,
	allConnectorTools,
	createConnectorRouterTool,
	ConnectorToolRouter,
} from './bridge/tools/connector/index.js'
export type {
	ConnectorToolConfig,
	ConnectorRouterInput,
	ConnectorToolStrategy,
	ConnectorToolRouterConfig,
} from './bridge/tools/connector/index.js'

export {
	buildAgentCard,
	runToA2ATask,
	isTerminalState,
	runStatusToA2AState,
	a2aMessageToCreateRun,
	messageToA2A,
	extractTextFromA2AMessage,
	a2aMessageToInput,
	mapRunToA2AEvent,
	mapSessionToA2AEvent,
} from './bridge/a2a/index.js'
export type { CreateRunFromA2A } from './bridge/a2a/index.js'

export {
	mapRunToStreamEvent,
	mapSessionToStreamEvent,
} from './bridge/sse/index.js'
export type { MappedStreamEvent } from './bridge/sse/index.js'

export {
	AgentBus,
	CircuitBreaker,
	FileLockManager,
	EditOwnershipTracker,
} from './bus/index.js'
export type { AgentBusConfig } from './bus/index.js'

export { VerificationGate, evaluateRule } from './verification/index.js'
export type { ToolCallContext } from './verification/index.js'

export { buildCoordinatorTools } from './tools/coordinator/index.js'
export type { CoordinatorToolsOptions, TaskLaunchedCallback } from './tools/coordinator/index.js'

export { InMemoryCredentialVault } from './vault/index.js'

// Telemetry runtime surface moved to `@namzu/telemetry` in 0.4.0.
// See docs/migration/0.4.md. Consumers import from `@namzu/telemetry`
// and `@namzu/telemetry/attributes` instead of the SDK barrel.

// Session hierarchy runtime primitives (Phase 9 — public API freeze for 0.2.0).
// Convention #4: root barrel imports sub-barrels only, never concrete files.
export * from './session/index.js'
export * from './store/session/index.js'

export {
	WorkingStateManager,
	serializeState,
	extractFromToolCall,
	extractFromToolResult,
	extractFromUserMessage,
	extractFromAssistantMessage,
	buildVerifiedSummary,
	findDanglingMessages,
	removeDanglingMessages,
	findSafeTrimIndex,
	NullManager,
	SlidingWindowManager,
	StructuredCompactionManager,
	createConversationManager,
} from './compaction/index.js'
export type {
	WorkingState,
	PlanSlot,
	FileSlot,
	FileAction,
	ToolResultSlot,
	CompactionStrategy,
	DanglingResult,
	ConversationManager,
} from './compaction/index.js'
