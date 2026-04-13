import type { PluginHookEvent, PluginHookResult } from '../../types/plugin/index.js'

/**
 * Interpret hook results from non-tool lifecycle events (run_start, run_end,
 * iteration_start, iteration_end, pre_llm_call, post_llm_call). These contexts
 * carry no mutable payload, so only `continue` and `error` are meaningful.
 *
 * Throws on `error` (propagated to run-failure path) or on action misuse
 * (skip / modify / retry / resume have no defined contract here).
 */
export function applyLifecycleHookResults(
	event: PluginHookEvent,
	results: readonly PluginHookResult[],
): void {
	for (const result of results) {
		switch (result.action) {
			case 'continue':
				continue
			case 'error':
				throw new Error(`Plugin hook ${event} reported error: ${result.message}`)
			case 'skip':
			case 'modify':
			case 'retry':
			case 'resume':
				throw new Error(
					`Plugin hook ${event} returned unsupported action '${result.action}' for a lifecycle event`,
				)
			default: {
				const _exhaustive: never = result
				throw new Error(`Unknown PluginHookResult: ${JSON.stringify(_exhaustive)}`)
			}
		}
	}
}
