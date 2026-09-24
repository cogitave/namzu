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
		const offset = jsonSyntaxErrorOffset(buffer)
		return { ok: false, parseError, ...(offset !== undefined ? { offset } : {}) }
	}
}

const OBJECT = 0
const ARRAY = 1

function isDigit(code: number): boolean {
	return code >= 0x30 && code <= 0x39
}

function isHexDigit(code: number): boolean {
	return isDigit(code) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66)
}

/**
 * Where a text stops being JSON: the offset of the first character that
 * cannot continue a valid JSON text (RFC 8259), the text's length when it
 * ended before its value did, or `undefined` when it is valid JSON.
 *
 * Found by scanning the text, not read from the parser's message. V8 names a
 * position for most failures, but for an unexpected bare token it only quotes
 * the text around it ("Unexpected token 'T', ... is not valid JSON"), and that
 * quote is cut short on a long input. `True`, `None`, `NaN` and `undefined`,
 * the literals a model carries over from Python or JavaScript, are exactly
 * those. Where V8 does name a position, this is the same one.
 *
 * Iterative, with an explicit stack, so deep nesting cannot overflow it.
 */
export function jsonSyntaxErrorOffset(text: string): number | undefined {
	const end = text.length
	const containers: number[] = []
	let i = 0
	let expect: 'value' | 'valueOrClose' | 'key' | 'keyOrClose' | 'colon' | 'next' = 'value'

	const skipWhitespace = () => {
		while (i < end) {
			const code = text.charCodeAt(i)
			if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return
			i++
		}
	}
	// Each reader below consumes one token from `i` and returns the offset of
	// the first character that does not fit it, or `undefined` when it fits.
	const readString = (): number | undefined => {
		i++
		while (i < end) {
			const code = text.charCodeAt(i)
			if (code === 0x22) {
				i++
				return undefined
			}
			if (code < 0x20) return i
			i++
			if (code !== 0x5c) continue
			if (i >= end) return end
			const escaped = text[i] as string
			if (escaped === 'u') {
				for (let k = 1; k <= 4; k++) {
					if (i + k >= end) return end
					if (!isHexDigit(text.charCodeAt(i + k))) return i + k
				}
				i += 5
			} else if ('"\\/bfnrt'.includes(escaped)) {
				i++
			} else {
				return i
			}
		}
		return end
	}
	const readDigits = (): number | undefined => {
		if (i >= end) return end
		if (!isDigit(text.charCodeAt(i))) return i
		while (i < end && isDigit(text.charCodeAt(i))) i++
		return undefined
	}
	const readNumber = (): number | undefined => {
		if (text[i] === '-') i++
		if (text[i] === '0') {
			i++
		} else {
			const bad = readDigits()
			if (bad !== undefined) return bad
		}
		if (text[i] === '.') {
			i++
			const bad = readDigits()
			if (bad !== undefined) return bad
		}
		if (text[i] === 'e' || text[i] === 'E') {
			i++
			if (text[i] === '+' || text[i] === '-') i++
			const bad = readDigits()
			if (bad !== undefined) return bad
		}
		return undefined
	}
	const readLiteral = (word: string): number | undefined => {
		for (const expected of word) {
			if (i >= end) return end
			if (text[i] !== expected) return i
			i++
		}
		return undefined
	}

	for (;;) {
		skipWhitespace()
		if (i >= end) return expect === 'next' && containers.length === 0 ? undefined : end
		const char = text[i] as string
		switch (expect) {
			case 'valueOrClose':
				if (char === ']') {
					containers.pop()
					i++
					expect = 'next'
					continue
				}
				expect = 'value'
				continue
			case 'value': {
				if (char === '{') {
					containers.push(OBJECT)
					i++
					expect = 'keyOrClose'
					continue
				}
				if (char === '[') {
					containers.push(ARRAY)
					i++
					expect = 'valueOrClose'
					continue
				}
				let bad: number | undefined
				if (char === '"') bad = readString()
				else if (char === '-' || isDigit(text.charCodeAt(i))) bad = readNumber()
				else if (char === 't') bad = readLiteral('true')
				else if (char === 'f') bad = readLiteral('false')
				else if (char === 'n') bad = readLiteral('null')
				else return i
				if (bad !== undefined) return bad
				expect = 'next'
				continue
			}
			case 'keyOrClose':
				if (char === '}') {
					containers.pop()
					i++
					expect = 'next'
					continue
				}
				expect = 'key'
				continue
			case 'key': {
				if (char !== '"') return i
				const bad = readString()
				if (bad !== undefined) return bad
				expect = 'colon'
				continue
			}
			case 'colon':
				if (char !== ':') return i
				i++
				expect = 'value'
				continue
			case 'next': {
				const open = containers.at(-1)
				if (open === undefined) return i
				if (char === ',') {
					i++
					expect = open === OBJECT ? 'key' : 'value'
					continue
				}
				if (char === (open === OBJECT ? '}' : ']')) {
					containers.pop()
					i++
					continue
				}
				return i
			}
		}
	}
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
