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

export { NullManager, SlidingWindowManager, StructuredCompactionManager } from './managers/index.js'

export { createConversationManager } from './factory.js'
