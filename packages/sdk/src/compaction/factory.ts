import type { CompactionConfig } from '../config/runtime.js'
import type { ConversationManager } from './interface.js'
import { NullManager } from './managers/null.js'
import { SlidingWindowManager } from './managers/slidingWindow.js'
import { StructuredCompactionManager } from './managers/structured.js'
import type { CompactionStrategy } from './types.js'

/**
 * Factory function to create a ConversationManager based on the configured strategy.
 *
 * @param strategy - Selected compaction strategy: 'structured', 'sliding-window', or 'disabled'
 * @param config - CompactionConfig with keepRecentMessages and other settings
 * @returns Instantiated ConversationManager
 *
 * @throws If strategy is not recognized (exhaustiveness check ensures this never happens at runtime)
 *
 * @example
 * ```typescript
 * const manager = createConversationManager('structured', config)
 * const trimmed = manager.applyManagement(messages)
 * ```
 */
export function createConversationManager(
	strategy: CompactionStrategy,
	config: CompactionConfig,
): ConversationManager {
	switch (strategy) {
		case 'structured':
			return new StructuredCompactionManager(config)
		case 'sliding-window':
			return new SlidingWindowManager({
				keepRecentMessages: config.keepRecentMessages,
			})
		case 'disabled':
			return new NullManager()
		default: {
			const _exhaustive: never = strategy
			throw new Error(`Unknown compaction strategy: ${_exhaustive}`)
		}
	}
}
