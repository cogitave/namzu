export type {
	WorkingState,
	PlanSlot,
	FileSlot,
	FileAction,
	ToolResultSlot,
	CompactionStrategy,
} from './types.js'

export type { DanglingResult } from './dangling.js'

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

export {
	findDanglingMessages,
	removeDanglingMessages,
	findSafeTrimIndex,
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
