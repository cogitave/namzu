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
export type { WorkerCodeRuntimeOptions } from './execution/code-runtime/worker.js'
export type {
	CodeRunOutcome,
	CodeRunResult,
	CodeRuntime,
	HostCallContext,
	HostCallHandler,
	HostCallRequest,
	HostCallResult,
	RunCodeOptions,
} from './execution/code-runtime/types.js'
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
export type * from './types/browser/index.js'
export type { BrowserActToolInput, BrowserToolInput } from './tools/builtins/browser.js'
export type {
	BrowserOriginVerdict,
	BrowserSitePatternVerdict,
	BrowserUrlVerdict,
} from './tools/builtins/browser-url.js'
export type * from './types/authorization/index.js'
export type * from './types/bus/index.js'
export type * from './types/probe/index.js'
export type * from './types/doctor/index.js'
export type * from './types/workspace/index.js'
export type * from './types/goal/index.js'

// The session → turn → message surface: sessions, turns, their events,
// records, checkpoints and durable state. The only definition of a turn.
export type * from './types/session/index.js'

// ─── wire surface (contracts/) ────────────────────────────────────────────

// Turn and session wire shapes (WireTurn, WireTurnStatus, CreateTurnRequest,
// CreateEphemeralSessionRequest, SessionStreamEvent, …) come through
// `export * from './contracts/session/index.js'` in public-runtime.ts.
export type {
	AgentDefaults,
	AgentInfo,
	ApiError,
	ApiErrorType,
	ApiPermissionMode,
	CreateMessageRequest,
	ISOTimestamp,
	PaginatedResponse,
	PaginationParams,
	SessionTreeNode,
	ToolCallInfo,
} from './contracts/api.js'

// ─── runtime-config type shapes ───────────────────────────────────────────

export type {
	CompactionConfig,
	PluginRuntimeConfig,
	RuntimeConfig,
} from './config/runtime.js'

// ─── named type re-exports from mixed runtime+type modules ────────────────
// These modules contain runtime exports too; those go in public-runtime.ts.

export type {
	AdvisoryCallContext,
	AdvisoryTurnContext,
	AdvisoryExecutionResult,
} from './advisory/index.js'

export type { CacheRates, ModelPricing } from './utils/cost.js'
export type { VendorRates } from './pricing/index.js'
export type { PricingSubject } from './manager/session/turn-recorder.js'
export type {
	FrontmatterOptions,
	FrontmatterValue,
	ParsedFrontmatter,
} from './utils/frontmatter.js'
export type {
	CompiledSkillGrant,
	SkillGrantEntry,
	SkillGrantToolResolver,
} from './authorization/skill-grant.js'
export type { Logger } from './utils/logger.js'
export type {
	LevelFilter,
	LogRecord,
	LogSink,
	LogSinkCounters,
	Resource,
	Severity,
} from './utils/log/index.js'
export type {
	ShellCompressOptions,
	ShellCompressResult,
} from './utils/shell-compress.js'

export type { QueryParams } from './runtime/query/index.js'
export type {
	ProjectInstructionCallbackContext,
	ProjectInstructionContext,
	ProjectInstructionSnapshotUpdate,
	ToolResultObservation,
} from './runtime/query/project-instructions.js'
export type {
	PromptCacheConfig,
	PromptCacheInput,
} from './runtime/query/prompt-cache.js'

export type {
	LimitCheckResult,
	LimitCheckerState,
	TurnReporter,
} from './turn/index.js'

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
	MarkdownMemoryStoreConfig,
	MemoryContentRejection,
	MemoryImportOutcome,
	RenderedMemoryIndex,
	Timestamped,
} from './store/index.js'

export type {
	ManagedRegistryConfig,
	ToolExecutionResult,
	ToolRegistryForkOptions,
} from './registry/index.js'

export type { PluginLifecycleManagerConfig } from './plugin/lifecycle.js'
export type {
	AgentDefinitionRoot,
	AgentFileDefinition,
	DiscoverAgentDefinitionsOptions,
	DiscoveredAgentDefinitions,
	SkippedAgentFile,
} from './agents/file-definitions.js'
export type {
	ShellHookEntry,
	ShellHookEvent,
	ShellHookInput,
	ShellHookOptions,
	ShellHookOutcome,
	ShellHooksConfig,
} from './plugin/shell-hook.js'

export type {
	PlanApprovalHandler,
	PlanEvent,
	PlanEventListener,
} from './manager/index.js'

export type { DefineToolOptions } from './tools/defineTool.js'

export type { AdvisoryToolsOptions } from './tools/advisory/index.js'

export type {
	CoordinatorToolsOptions,
	TaskLaunchedCallback,
} from './tools/coordinator/index.js'

export type {
	RegisterSharedSessionPlanInput,
	SharedSessionWorkspaceConfig,
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

export type {
	A2AContextResolution,
	CreateTurnFromA2A,
	MapTurnToA2ATaskOptions,
} from './bridge/a2a/index.js'
export type {
	ExternalSessionLookup,
	ExternalSessionResolution,
	ResolveExternalSessionOptions,
} from './bridge/external-session.js'

export type { CheckpointRecords, RecordedPark } from './runtime/query/checkpoint.js'

export type { TaskContextScope } from './store/task/context.js'

export type { TaskToolScope } from './tools/task/index.js'

export type { MappedStreamEvent } from './bridge/sse/index.js'

export type { AgentBusConfig } from './bus/index.js'

export type { ToolCallContext } from './authorization/index.js'
export type { PermissionPreset } from './authorization/index.js'
export type { EvaluateRuleOptions } from './authorization/rules.js'
export type {
	ShellCommand,
	ShellLexOptions,
	ShellLexResult,
	ShellRedirection,
	ShellWord,
} from './authorization/shell-lexer.js'

export type {
	DiskSessionStoreConfig,
	LinkageView,
} from './store/session/index.js'

// Public constructor contracts. A class reachable from the package root must
// not force consumers to reproduce its dependency/config shape by hand.
export type { DiskTopicStateStoreConfig } from './store/topic/state.js'
export type { EnvCredentialProviderOptions } from './vault/CredentialProvider.js'
export type { DiskMessageFeedbackStoreConfig } from './store/feedback/disk.js'
export type { MessageExistenceCheck } from './store/feedback/memory.js'
export type { AgentManagerDeps } from './manager/agent/lifecycle.js'
export type { ProjectManagerDeps } from './manager/project/lifecycle.js'
export type { TopicManagerDeps } from './manager/topic/lifecycle.js'
export type { FileLockManagerConfig } from './bus/lock.js'
export type { GitWorktreeDriverConfig } from './session/workspace/git-worktree.js'
export type { CapacityDimension } from './session/handoff/capacity.js'
export type { HandoffLockRejectedReason } from './session/handoff/version.js'
export type { SessionSummaryMaterializerDeps } from './session/summary/materialize.js'
export type { ArchivalManagerDeps } from './session/retention/archive.js'
export type { ArchiveBackendRef } from './types/retention/archive-backend-ref.js'
export type { DiskArchiveBackendConfig } from './session/retention/disk-backend.js'
export type { SlidingWindowManagerConfig } from './compaction/managers/slidingWindow.js'

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
	PinSlot,
	WorkingStatePin,
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

export type {
	CreateSessionGoalParams,
	DiskSessionGoalStoreConfig,
	EditSessionGoalParams,
	InMemorySessionGoalStoreConfig,
	SessionGoalStore,
} from './store/goal/index.js'
export type { ResolveGoalRoundAuthority } from './tools/goal/index.js'
export type { ActiveSessionGoal } from './manager/goal/activation.js'

export type {
	AgentHandle,
	AgentHandleOptions,
	AgentHandleStatus,
} from './agents/handle.js'

export type {
	CredentialDescription,
	CredentialProvider,
	CredentialRef as CredentialName,
	ResolvedCredential,
} from './vault/CredentialProvider.js'

// Who answers when a turn asks a human, as a value rather than a closure
// captured at `query()` start. See `types/hitl/policy.ts`.
export type {
	ApprovalPolicy,
	ApprovalPolicyChange,
	ApprovalPolicyChangedEvent,
	SessionApprovalPolicy,
} from './types/hitl/policy.js'

export type {
	GoalSources,
	ProtectedReason,
	SalienceConfig,
	SalienceWeights,
	ScoreOptions,
	ScoredMessage,
	WorkingSetAction,
	WorkingSetOptions,
	WorkingSetPlan,
} from './compaction/salience/index.js'
export type { ConsolidationMeta } from './compaction/consolidation.js'
export type {
	CompactionPlan,
	CompactionPlanInput,
	CompactionSkipReason,
} from './compaction/plan.js'

export type {
	ReviewExemption,
	ReviewMode,
	ReviewPolicyOptions,
	ToolReviewAnswer,
	ToolReviewPrompt,
	ToolReviewRequest,
} from './runtime/query/review-policy.js'

export type {
	CodingAgentDoctrineOptions,
	PromptContribution,
	PromptContributionContext,
	PromptPlacement,
	ResidentStepPromptOptions,
	ResidentStepContextOptions,
	ResidentStepContextBundle,
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

export type {
	AttachmentOperationOptions,
	AttachmentResolutionOptions,
	AttachmentStore,
	StoredAttachment,
	StoredBytes,
} from './store/attachment/index.js'

export type {
	ReadModel,
	SessionStatusReadModelOptions,
	SessionStatusState,
} from './read-model/index.js'

export type {
	SessionQueryOptions,
	SessionTranscriptUnavailableReason,
	ShedPass,
} from './session-query/index.js'

export type {
	OpenTerminalOptions,
	PtyLoader,
	PtyModule,
	PtyProcess,
	TerminalSession,
	TerminalSize,
} from './sandbox/terminal.js'

// Existing Topic snapshots can initialize an in-memory delegation store.
export type { Topic, TopicStatus } from './types/topic/entity.js'

// Token ledgers (SessionTokenBudget*, keyed by rootSessionId + rootTurnId)
// come through `export * from './store/budget/index.js'` in public-runtime.ts.

export type {
	RequestContextPart,
	RequestContextSnapshot,
	RequestContextChange,
} from './runtime/query/request-context.js'

export type { ResidentDecision, ResidentState, ResidentStore } from './manager/resident/store.js'
export type {
	ResidentActivityScope,
	ResidentAdmission,
	ResidentSettlement,
	ResidentActivityOptions,
	ResidentActivityPage,
	ResidentActivitySource,
} from './manager/resident/activity.js'
export type {
	ResidentConsumptionReceipt,
	ResidentConsumptionResolver,
	ResidentConsumptionOptions,
	ResidentConsumptionAttempt,
	ResidentConsumptionReport,
} from './manager/resident/consumption.js'
export type {
	ResidentHistoryScope,
	ResidentHistoryAddress,
	ResidentHistoryMatch,
	ResidentHistorySearchOptions,
	ResidentHistorySearchResult,
	ResidentHistoryReadOptions,
	ResidentHistoryText,
	ResidentHistoryReadResult,
	ResidentHistorySource,
} from './manager/resident/history.js'
export type {
	ResidentStep,
	ResidentStepResult,
	ResidentLoopOptions,
} from './manager/resident/loop.js'
export type { ResidentExecutionStore } from './manager/resident/store.js'
export type {
	ResidentAgendaState,
	ResidentAgendaStore,
	ResidentPursuit,
} from './manager/resident/agenda.js'
export type {
	ResidentHostResult,
	ResidentHostRunOptions,
	ResidentPursuitStep,
} from './manager/resident/host.js'

export type {
	ResidentObservation,
	ResidentFeedback,
	ResidentSelectionConfig,
	ResidentCandidate,
	ResidentSelection,
	ResidentSelector,
} from './manager/resident/initiative.js'
export type { ResidentHostOptions, ResidentObserver } from './manager/resident/host.js'
export type {
	ResidentProposal,
	ResidentProposalLimits,
	ResidentProposalOrigin,
} from './manager/resident/proposal.js'

export type { ResidentMessageFactory } from './manager/resident/host.js'
export type {
	ResidentMessageInput,
	ResidentOutboxMessage,
	ResidentDeliveryOutcome,
	ResidentOutboxStore,
	ResidentDeliveryGate,
	ResidentMessageTransport,
	ResidentDeliveryOptions,
	ResidentDeliveryResult,
} from './manager/resident/outbox.js'
export type { ResidentDeliveryWindowConfig } from './manager/resident/delivery-window.js'

export type { ResidentStepContext, ResidentContextualStep } from './manager/resident/host.js'
export type {
	ResidentLearningEvidence,
	ResidentSkillCandidate,
	ResidentLearnedSkill,
	ResidentLearningState,
	ResidentProfileUpdate,
	ResidentSkillEvaluation,
	ResidentLearningProjectionOptions,
	ResidentLearningSource,
	ResidentLearningProjection,
} from './manager/resident/learning.js'
export type {
	ResidentLearningStage,
	ResidentLearningReceipt,
	ResidentLearningConsumption,
	ResidentLearningCycleEvent,
	ResidentLearningCycleContext,
	ResidentLearningGenerationContext,
	ResidentLearningExplorationContext,
	ResidentLearningExploration,
	ResidentLearningEvaluationContext,
	ResidentLearningCycleOptions,
	ResidentLearningCycleResult,
} from './manager/resident/learning-cycle.js'

export type {
	ResidentArchiveRequest,
	ResidentArchiveEntry,
	ResidentArchivePage,
	ResidentArchiveListOptions,
} from './manager/resident/agenda.js'

export type {
	SessionEvidenceScope,
	SessionEvidenceSourceOptions,
	SessionEvidenceSearchOptions,
	SessionEvidenceMatch,
	SessionEvidenceSearchResult,
	SessionEvidenceReadOptions,
	SessionEvidenceReadResult,
	SessionEvidenceSource,
	SessionTextEvidenceSearchOptions,
	SessionTextEvidenceMatch,
	SessionTextEvidenceSearchResult,
	SessionTextEvidenceReadResult,
	SessionTextEvidenceSource,
} from './store/evidence/types.js'
export type { EvidenceRecordKind } from './store/evidence/source-kind.js'
export type {
	ResidentToolEvidenceScope,
	ResidentSettledInvocation,
	ResidentToolEvidenceOptions,
	ResidentToolEvidenceSearchOptions,
	ResidentToolEvidenceSearchResult,
	ResidentToolEvidenceReadOptions,
	ResidentToolEvidenceReadResult,
	ResidentToolEvidenceSource,
} from './manager/resident/tool-evidence.js'

export type { ResidentEvidenceRecallOptions } from './manager/resident/evidence-recall.js'
export type {
	JsonClaimValue,
	JsonClaimRequirement,
	JsonClaimReadRequest,
	JsonClaimObservation,
	JsonClaimReceipt,
	JsonClaimVerdict,
	JsonClaimVerifierOptions,
	JsonClaimVerifier,
} from './turn/json-claim-verifier.js'

export type {
	SqliteResidentLearningStoreOptions,
	ResidentLearningArtifact,
	ResidentLearningRecordedUsage,
	ResidentLearningCycleSummary,
	ResidentLearningDiscoveryOptions,
	ResidentLearningDiscoveryResult,
} from './manager/resident/learning-store.js'
export type {
	ResidentLearningObservation,
	ResidentLearningObservationRecord,
	ResidentLearningTarget,
} from './manager/resident/learning-observation.js'

// ─── sessions, turns and the session log: paths and log lines ────────────
// The session types themselves come through `./types/session/index.js` above.

export type { ResolveNamzuHomeOptions } from './session/home.js'
export type {
	EnsureProjectOptions,
	EnsuredProject,
	SessionLocator,
	SessionPathsOptions,
	TempRootOptions,
} from './session/paths.js'
export type {
	ParsedSessionLogLine,
	SessionLogLineFault,
} from './session/log-hash.js'

// Scheduled jobs: the time engine's and evaluator's types. The unions here
// may grow in a minor release; switch over them with a `default:` branch.
export type {
	CronExpression,
	DescribeScheduleOptions,
	OccurrenceCount,
	ParseScheduleOptions,
	ScheduleAtSpec,
	ScheduleCronSpec,
	ScheduleDecision,
	ScheduleEvaluationInput,
	ScheduleEvaluationJob,
	ScheduleEvaluationState,
	ScheduleEverySpec,
	ScheduleFireTrigger,
	ScheduleJobLifecycle,
	ScheduleMissedReason,
	ScheduleObservedGap,
	ScheduleSkipReason,
	ScheduleSpec,
} from './schedules/index.js'
export type {
	ScheduleBrowserGrant,
	ScheduleBrowserSiteLevel,
	ScheduleConfirmAnswer,
	ScheduleConfirmRequest,
	ScheduleJobDraft,
	ScheduleJobPreview,
	ScheduleJobSummary,
	ScheduleRuleEffect,
	ScheduleToolHost,
	SessionLoop,
	SessionLoopHost,
} from './tools/schedules/index.js'
