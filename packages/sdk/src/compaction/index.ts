export type {
	WorkingState,
	PlanSlot,
	FileSlot,
	FileAction,
	ToolResultSlot,
	CompactionStrategy,
} from './types.js'

export type {
	DanglingResult,
	ToolHistoryRepairReport,
	ToolHistoryRepairResult,
} from './dangling.js'

export type { ConversationManager } from './interface.js'

export { createSlidingWindowReducer } from './reducer.js'
export type {
	ContextReducer,
	ContextReduction,
	ContextReductionReason,
	SlidingWindowOptions,
} from './reducer.js'

export { WorkingStateManager } from './manager.js'

export { serializeState } from './serializer.js'

export {
	extractFromToolCall,
	extractFromToolResult,
	extractFromUserMessage,
	extractFromAssistantMessage,
} from './extractor.js'

export { buildVerifiedSummary } from './verifier.js'
export type { CompactionVerificationOptions } from './verifier.js'

export {
	findDanglingMessages,
	findSafeTrimIndex,
	removeDanglingMessages,
	repairToolMessageHistory,
	toolHistoryRepairChanged,
} from './dangling.js'

export { findRetainedIndices } from './retention.js'

export { NullManager, SlidingWindowManager, StructuredCompactionManager } from './managers/index.js'

export { createConversationManager } from './factory.js'
export {
	DEFAULT_ASSUMED_CONTEXT_WINDOW,
	lookupContextWindow,
	resolveContextWindow,
} from './context-window.js'
export type { ResolvedContextWindow } from './context-window.js'

export {
	clearStaleToolResults,
	isClearedToolResult,
	DEFAULT_KEEP_RECENT_TOOL_RESULTS,
	DEFAULT_MIN_CHARS_TO_CLEAR,
} from './tool-result-editing.js'
export type { ToolResultEditConfig, ToolResultEditOutcome } from './tool-result-editing.js'

// Host-callable compaction: "compact this conversation" as an action a host
// can offer, rather than something that only happens when a threshold trips.
export { compactNow, compactRegion } from './manual.js'
export type { CompactionResult, CompactNowInput, CompactRegionInput } from './manual.js'
export { COMPACTION_HEADER, buildCompactionMessage, isCompactionMessage } from './summary.js'

// The salience-scored working set: every message scored, the least salient
// evicted first. See `docs/sdk/salience-working-set.md`.
export {
	DEFAULT_SALIENCE_CONFIG,
	DEFAULT_SALIENCE_WEIGHTS,
	buildGoal,
	isStubbedNarration,
	messageText,
	planWorkingSet,
	scoreMessages,
} from './salience/index.js'
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
} from './salience/index.js'
export { DEFAULT_SOFT_TARGET, planSalienceWorkingSet } from './plan.js'

// Episodic → semantic: what a run learned, as the entry a later run searches.
export { CONSOLIDATION_TAG, consolidationEntry } from './consolidation.js'
export type { ConsolidationMeta } from './consolidation.js'
