import type { TopicManager } from './lifecycle.js'

/**
 * A dependency on the Topic lifecycle gate during the `threadManager` rename
 * window.
 *
 * At least one spelling is required. Supplying both is accepted only when
 * they name the same manager instance; choosing one of two different gates by
 * property order would make archive enforcement depend on object shape.
 */
export type TopicManagerDependency =
	| {
			readonly topicManager: TopicManager
			/** @deprecated Use {@link topicManager}. */
			readonly threadManager?: TopicManager
	  }
	| {
			readonly topicManager?: never
			/** @deprecated Use `topicManager`. */
			readonly threadManager: TopicManager
	  }

/** Resolve the canonical manager or refuse an ambiguous/missing runtime input. */
export function resolveTopicManager(dependency: {
	readonly topicManager?: TopicManager
	readonly threadManager?: TopicManager
}): TopicManager {
	const { topicManager, threadManager } = dependency
	if (topicManager && threadManager && topicManager !== threadManager) {
		throw new TypeError(
			'topicManager and deprecated threadManager refer to different TopicManager instances; provide one manager, or pass the same instance under both names during migration.',
		)
	}
	const resolved = topicManager ?? threadManager
	if (!resolved) {
		throw new TypeError('A TopicManager is required as topicManager.')
	}
	return resolved
}
