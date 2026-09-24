import type { ToolInputError } from '../../../types/message/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'

/**
 * The most argument text a `tool_input_completed` event carries for a call
 * that could not be read. The event is written to the session log, and a cut
 * off `write` can hold a whole file body; the assistant message keeps all of
 * it as `metadata.partialArguments`.
 */
export const PARTIAL_ARGUMENTS_EVENT_LIMIT = 16_384

export type ParsedToolArguments =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly parseError: string; readonly offset?: number }

/**
 * Parse a streamed argument buffer. Empty means no arguments, the shape a
 * no-parameter tool arrives in.
 */
export function parseToolArguments(buffer: string): ParsedToolArguments {
	if (!buffer) return { ok: true, value: {} }
	try {
		return { ok: true, value: JSON.parse(buffer) }
	} catch (err) {
		const parseError = err instanceof Error ? err.message : String(err)
		const offset = parseErrorOffset(parseError, buffer.length)
		return { ok: false, parseError, ...(offset !== undefined ? { offset } : {}) }
	}
}

/**
 * Where the parser stopped, from its own message. V8 names a position for
 * most failures; "Unexpected end of JSON input" names none because the
 * failure is the end itself, and "Unexpected token" quotes the text instead.
 */
function parseErrorOffset(message: string, length: number): number | undefined {
	const at = /\bposition (\d+)/.exec(message)
	if (at?.[1] !== undefined) return Number(at[1])
	if (/\bend of (?:JSON )?input\b/i.test(message)) return length
	return undefined
}

/**
 * Classify arguments that did not parse, from how the response ended.
 *
 * Deliberately not from the text: a buffer that stops mid-string looks the
 * same whether the output limit cut it or the model closed its turn early,
 * and only the finish reason tells the two apart. `finishReason` is what the
 * stream reported, `undefined` when it reported nothing — a stream that died
 * or was dropped before its final frame, which is a cut-off too. `sizes`
 * are the characters of this call's arguments and of the whole response.
 */
export function classifyUnreadableToolInput(
	failure: { readonly parseError: string; readonly offset?: number },
	sizes: { readonly length: number; readonly responseLength: number },
	finishReason: ChatCompletionResponse['finishReason'] | undefined,
): ToolInputError {
	const cutOff =
		finishReason === undefined || finishReason === 'length' || finishReason === 'content_filter'
	return {
		reason: cutOff ? 'truncated' : 'malformed',
		...(finishReason !== undefined ? { finishReason } : {}),
		parseError: failure.parseError,
		...(failure.offset !== undefined ? { offset: failure.offset } : {}),
		length: sizes.length,
		responseLength: sizes.responseLength,
	}
}

/**
 * The first {@link PARTIAL_ARGUMENTS_EVENT_LIMIT} characters, never ending
 * on half of a surrogate pair.
 */
export function capPartialArguments(buffer: string): string {
	if (buffer.length <= PARTIAL_ARGUMENTS_EVENT_LIMIT) return buffer
	let end = PARTIAL_ARGUMENTS_EVENT_LIMIT
	const last = buffer.charCodeAt(end - 1)
	if (last >= 0xd800 && last <= 0xdbff) end -= 1
	return buffer.slice(0, end)
}
