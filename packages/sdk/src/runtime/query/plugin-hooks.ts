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
				if (event !== 'user_prompt_submit' && event !== 'subagent_start') {
					throw new Error(
						`Plugin hook ${event} returned 'annotate', which only user_prompt_submit and subagent_start accept`,
					)
				}
				if (result.text.trim().length > 0) annotations.push(result.text.trim())
				continue
			case 'skip':
				// `turn_end`, `subagent_stop` and `pre_compact` answer with `skip`
				// to keep the turn going or to cancel a pass. The sites that can act
				// on that read the results themselves; a site that cannot (the
				// final `turn_end` of a turn that already ended) has nothing to
				// refuse and carries on.
				if (event === 'turn_end' || event === 'subagent_stop' || event === 'pre_compact') {
					continue
				}
				// The one lifecycle event with a verdict: a hook may refuse the
				// prompt before the model sees it, and the turn ends there.
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

/**
 * What a `pre_tool_use` hook's SKIP goes back to the model as.
 *
 * A function rather than a template at the one call site, because the text is
 * a SIGNAL as well as prose. A skipped call gets a non-error receipt — the
 * hook refused it, nothing failed — so the transcript's only record that the
 * tool never ran is this sentence. `file-evidence-replay.ts` reads it back to
 * keep a skipped `write` from being replayed as a body the file now holds,
 * and it can only do that while one function owns both the writing and the
 * recognising.
 */
export function skippedToolResultText(toolName: string, reason: string): string {
	return `Tool ${toolName} skipped by plugin: ${reason}`
}

/** Whether `content` is the receipt {@link skippedToolResultText} writes for `toolName`. */
export function isSkippedToolResult(toolName: string, content: string): boolean {
	return content.startsWith(skippedToolResultText(toolName, ''))
}
