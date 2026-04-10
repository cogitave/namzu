import type { TaskRouterConfig, TaskType } from '../types/router/index.js'

/**
 * Resolves the model ID for a given task type using the router config.
 *
 * Fallback chain: `router[taskType]` -> `router.default` -> `primaryModel`
 */
export function resolveTaskModel(
	taskType: TaskType,
	router: TaskRouterConfig | undefined,
	primaryModel: string,
): string {
	if (!router) return primaryModel

	const specific = router[taskType]
	if (specific) return specific

	if (taskType !== 'default') {
		const fallback = router.default
		if (fallback) return fallback
	}

	return primaryModel
}
