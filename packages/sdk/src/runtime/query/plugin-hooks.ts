import { NamzuError } from '../../types/errors/index.js'
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
): string[] {
	const annotations: string[] = []
	for (const result of results) {
		switch (result.action) {
			case 'continue':
				continue
			case 'annotate':
				if (event !== 'user_prompt_submit') {
					throw new Error(
						`Plugin hook ${event} returned 'annotate', which only user_prompt_submit accepts`,
					)
				}
				if (result.text.trim().length > 0) annotations.push(result.text.trim())
				continue
			case 'skip':
				// The one lifecycle event with a verdict: a hook may refuse the
				// prompt before the model sees it, and the run ends there.
				if (event === 'user_prompt_submit') {
					throw new NamzuError({
						code: 'plugin_error',
						message: `Prompt blocked by hook: ${result.reason}`,
						details: { event, blocked: true, reason: result.reason },
					})
				}
				throw new Error(
					`Plugin hook ${event} returned unsupported action 'skip' for a lifecycle event`,
				)
			case 'error':
				throw new NamzuError({
					code: 'plugin_error',
					message: `Plugin hook ${event} reported error: ${result.message}`,
					details: { event },
				})
			case 'modify':
			case 'retry':
			case 'replace':
				throw new Error(
					`Plugin hook ${event} returned unsupported action '${result.action}' for a lifecycle event`,
				)
			default: {
				const _exhaustive: never = result
				throw new Error(`Unknown PluginHookResult: ${JSON.stringify(_exhaustive)}`)
			}
		}
	}
	return annotations
}
