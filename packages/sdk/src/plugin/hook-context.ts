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

/** The most characters of the model's last message a `turn_end` or `subagent_stop` hook receives. */
export const MAX_LAST_MESSAGE_HOOK_CHARS = 8_000

/** The most characters of a compaction summary a `post_compact` hook receives. */
export const MAX_COMPACTION_SUMMARY_HOOK_CHARS = 8_000

/** `text` cut to `limit` characters, with a mark when it was cut. */
function boundText(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text
}

/** The model's last message as a stop hook receives it; `undefined` when it holds no text. */
export function boundLastAssistantMessage(text: string | null | undefined): string | undefined {
	if (text === undefined || text === null || text.trim().length === 0) return undefined
	return boundText(text, MAX_LAST_MESSAGE_HOOK_CHARS)
}

/** A compaction summary as a `post_compact` hook receives it; `undefined` when empty. */
export function boundCompactionSummary(text: string | null | undefined): string | undefined {
	if (text === undefined || text === null || text.trim().length === 0) return undefined
	return boundText(text, MAX_COMPACTION_SUMMARY_HOOK_CHARS)
}

/**
 * What `pre_compact` hooks said the summary should keep, joined in answer
 * order and bounded to {@link MAX_HOOK_CONTEXT_CHARS}; `undefined` when none
 * said anything. A hook gives it as `annotate`, as `continue` with `context`,
 * or as `context` beside a `skip` (a refusal the pass overrides, as for a
 * pass the provider forced, still has its words heard).
 */
export function compactionHookInstructions(
	results: readonly PluginHookResult[],
): string | undefined {
	const texts: string[] = []
	for (const result of results) {
		const text =
			result.action === 'annotate'
				? result.text
				: result.action === 'continue' || result.action === 'skip'
					? result.context
					: undefined
		if (text !== undefined && text.trim().length > 0) texts.push(text.trim())
	}
	return texts.length === 0 ? undefined : boundHookContext(texts.join('\n\n'))
}
