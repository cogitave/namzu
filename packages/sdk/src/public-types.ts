// Public types surface of `@namzu/sdk`.
//
// Every pure shape a consumer might need for TypeScript type-checking:
// branded IDs, wire types, domain entities, discriminated unions, store
// contracts, event unions, config types.
//
// Rule: this file contains ONLY `export type` statements. Runtime values
// (classes, functions, constants, zod schemas, errors) live in
// `public-runtime.ts`. Tool builders live in `public-tools.ts`.
//
// The three-bucket taxonomy and its migration rationale were ratified in
// ses_011-sdk-public-surface.

// ─── per-domain shape surfaces ────────────────────────────────────────────

export type * from './types/ids/index.js'
export type * from './types/message/index.js'
export type * from './types/common/index.js'
export type { CoalesceOptions } from './streaming/coalesce.js'
export type * from './types/bidi/index.js'
export type * from './types/tool/index.js'
// The directory convention: what a loaded `agent/` directory is, and what the
// loader reports about the files it could not use.
export type * from './directory/types.js'
export type {
	DelegatePlan,
	DeriveSupervisorInput,
	SupervisorPlan,
} from './directory/derive-supervisor.js'
export type * from './types/toolset/index.js'
export type * from './types/permission/index.js'
export type * from './types/run/index.js'
export type * from './types/errors/index.js'
export type * from './types/provider/index.js'
export type * from './types/agent/index.js'
export type * from './types/decision/index.js'
export type * from './types/persona/index.js'
export type * from './types/activity/index.js'
export type * from './types/task/index.js'
export type * from './types/plan/index.js'
export type * from './types/hitl/index.js'
export type * from './types/rag/index.js'
export type * from './types/execution/index.js'
export type * from './types/connector/index.js'
export type * from './types/skills/index.js'
export type * from './types/a2a/index.js'
export type * from './types/router/index.js'
export type * from './types/advisory/index.js'
export type * from './types/memory/index.js'
export type * from './types/plugin/index.js'
export type * from './types/sandbox/index.js'
export type * from './types/structured-output/index.js'
export type * from './types/invocation/index.js'
export type * from './types/computer-use/index.js'
export type * from './types/authorization/index.js'
export type * from './types/bus/index.js'
export type * from './types/probe/index.js'
export type * from './types/doctor/index.js'
export type * from './types/workspace/index.js'

// Session-hierarchy type surface (ses_010 moved entities here).
export type * from './types/session/index.js'

// ─── wire surface (contracts/) ────────────────────────────────────────────

export type {
	AgentDefaults,
	AgentInfo,
	ApiError,
	ApiErrorType,
	ApiPermissionMode,
	CreateMessageRequest,
	CreateRunRequest,
	CreateStatelessRunRequest,
	ISOTimestamp,
	PaginatedResponse,
	PaginationParams,
	RunConfig,
	RunHierarchyNode,
	RunStopReason,
	RunUsage,
	StreamEvent,
	StreamEventType,
	ToolCallInfo,
	WireRun,
	WireRunStatus,
} from './contracts/api.js'

// ─── runtime-config type shapes ───────────────────────────────────────────

export type {
	CompactionConfig,
	PluginRuntimeConfig,
	RuntimeConfig,
} from './config/runtime.js'

// ─── named type re-exports from mixed runtime+type modules ────────────────
// These modules contain runtime exports too; those go in public-runtime.ts.

export type { AdvisoryCallContext, AdvisoryExecutionResult } from './advisory/index.js'

export type { CacheRates, ModelPricing } from './utils/cost.js'
export type { VendorRates } from './pricing/index.js'
export type { PricingSubject } from './manager/run/persistence.js'
export type { FrontmatterValue, ParsedFrontmatter } from './utils/frontmatter.js'
export type { Logger } from './utils/logger.js'
export type {
	LevelFilter,
	LogRecord,
	LogSink,
	LogSinkCounters,
	Resource,
	Severity,
} from './utils/log/index.js'
export type { ShellCompressOptions, ShellCompressResult } from './utils/shell-compress.js'

export type { QueryParams } from './runtime/query/index.js'
export type { PromptCacheConfig, PromptCacheInput } from './runtime/query/prompt-cache.js'

export type { LimitCheckResult, LimitCheckerState, RunReporter } from './run/index.js'

export type {
	AgentIdentity,
	DefineAgentOptions,
	Disposable,
	RunAgentOptions,
	RunAgentResult,
} from './agents/index.js'

export type {
	ActivityEvent,
	ActivityEventListener,
	DiskMemoryStoreConfig,
	DiskTaskStoreConfig,
	Identifiable,
	Timestamped,
} from './store/index.js'

export type { ManagedRegistryConfig, ToolExecutionResult } from './registry/index.js'

export type { PluginLifecycleManagerConfig } from './plugin/lifecycle.js'

export type { PlanApprovalHandler, PlanEvent, PlanEventListener } from './manager/index.js'

export type { DefineToolOptions } from './tools/defineTool.js'

export type { AdvisoryToolsOptions } from './tools/advisory/index.js'

export type { CoordinatorToolsOptions, TaskLaunchedCallback } from './tools/coordinator/index.js'

export type {
	RegisterSharedRunPlanInput,
	SharedRunWorkspaceConfig,
} from './session/workspace/index.js'

export type {
	ConnectorManagerConfig,
	EnvironmentConnectorManagerConfig,
	EnvironmentConnectorSetup,
	HybridExecutionContextOptions,
	LocalExecutionContextOptions,
	MCPServerResourceProvider,
	MCPServerPromptProvider,
	MCPServerToolProvider,
	RemoteExecutionContextOptions,
	TenantConnectorManagerConfig,
} from './connector/index.js'

export type {
	ConnectorRouterInput,
	ConnectorToolConfig,
	ConnectorToolRouterConfig,
	ConnectorToolStrategy,
} from './connector/tools/index.js'

export type { CreateRunFromA2A } from './bridge/a2a/index.js'

export type { MappedStreamEvent } from './bridge/sse/index.js'

export type { AgentBusConfig } from './bus/index.js'

export type { ToolCallContext } from './authorization/index.js'
export type { PermissionPreset } from './authorization/index.js'

export type { DiskSessionStoreConfig, LinkageView } from './store/session/index.js'

export type {
	ContextReducer,
	ContextReduction,
	ContextReductionReason,
	SlidingWindowOptions,
	ConversationManager,
	CompactionStrategy,
	DanglingResult,
	FileAction,
	FileSlot,
	PlanSlot,
	ToolResultSlot,
	WorkingState,
} from './compaction/index.js'
export type * from './eval/index.js'
export type * from './types/guardrail/index.js'

export type {
	HostCommandContext,
	HostCommandDescriptor,
	HostCommandOutcome,
	HostCommandRow,
	SerializableHostCommand,
} from './types/command/index.js'

export type { TopicState } from './types/topic/state.js'
export type {
	ObjectiveAdvance,
	ObjectiveAdvanceResult,
	ObjectiveBlock,
	ObjectivePhase,
	ObjectiveRefusal,
	ObjectiveRoundVerdict,
	TopicObjective,
} from './types/topic/objective.js'
export type {
	CreateObjectiveParams,
	DiskTopicObjectiveStoreConfig,
	TopicObjectiveStore,
} from './store/topic/objective.js'
export type {
	AdvanceObjectiveParams,
	DriveObjectiveParams,
} from './manager/topic/objective.js'

export type { AgentHandle, AgentHandleOptions, AgentHandleStatus } from './agents/handle.js'

export type {
	CredentialDescription,
	CredentialProvider,
	CredentialRef as CredentialName,
	ResolvedCredential,
} from './vault/CredentialProvider.js'

// Who answers when a run asks a human, as a value rather than a closure
// captured at `query()` start. See `types/hitl/policy.ts`.
export type {
	ApprovalPolicy,
	ApprovalPolicyChange,
	ApprovalPolicyChangedEvent,
	RunApprovalPolicy,
} from './types/hitl/policy.js'

export type {
	PromptContribution,
	PromptContributionContext,
	PromptPlacement,
} from './prompt/index.js'

export type {
	GuardedFetchConfig,
	WebFetchProvider,
	WebFetchRefusalReason,
	WebFetchRequest,
	WebFetchResult,
	WebSearchHit,
	WebSearchProvider,
	WebSearchRequest,
	WebSearchResult,
} from './connector/web/index.js'
