/**
 * Text a hook hands the model, and the one way it is framed and bounded.
 *
 * A hook's words reach the model from several places: after a tool result
 * (`[Hook note]`), on a prompt (`user_prompt_submit`), at a child's start and
 * at a session's start. Each is the operator's hook speaking, never the
 * user's or a tool's, and each is bounded, so a script that prints a file
 * cannot fill the window.
 */

import type { PluginHookResult } from '../types/plugin/index.js'

/** The most characters of hook text that reach the model in one place. */
export const MAX_HOOK_CONTEXT_CHARS = 8_000

/** `text` cut to {@link MAX_HOOK_CONTEXT_CHARS}, with a mark when it was cut. */
export function boundHookContext(text: string): string {
	return text.length > MAX_HOOK_CONTEXT_CHARS
		? `${text.slice(0, MAX_HOOK_CONTEXT_CHARS)}\n[truncated]`
		: text
}

/** The most characters a shell hook's replacement for a tool result may carry. */
export const MAX_HOOK_REPLACEMENT_CHARS = 32_000

/** A replacement for a tool result, cut to {@link MAX_HOOK_REPLACEMENT_CHARS}, marked when cut. */
export function boundHookReplacement(text: string): string {
	return text.length > MAX_HOOK_REPLACEMENT_CHARS
		? `${text.slice(0, MAX_HOOK_REPLACEMENT_CHARS)}\n[truncated]`
		: text
}

/**
 * Hook text framed so the model reads it as what the operator's hooks said:
 * the frame `user_prompt_submit` context carries.
 */
export function frameOperatorHookContext(texts: readonly string[]): string {
	return `Context from the operator's hooks:\n\n${texts.join('\n\n')}`
}

/**
 * What a session's `session_start` hooks said for the model, joined in answer
 * order and bounded; `undefined` when none said anything. A hook gives it as
 * `continue` with `context` or as `annotate`.
 */
export function sessionStartHookContext(results: readonly PluginHookResult[]): string | undefined {
	const texts: string[] = []
	for (const result of results) {
		const text =
			result.action === 'annotate'
				? result.text
				: result.action === 'continue'
					? result.context
					: undefined
		if (text !== undefined && text.trim().length > 0) texts.push(text.trim())
	}
	return texts.length === 0 ? undefined : boundHookContext(texts.join('\n\n'))
}
