import { describe, expect, it } from 'vitest'

import {
	PARTIAL_ARGUMENTS_EVENT_LIMIT,
	capPartialArguments,
	classifyUnreadableToolInput,
	jsonSyntaxErrorOffset,
	parseToolArguments,
} from './tool-input.js'

describe('parseToolArguments', () => {
	it('reads an empty buffer as no arguments', () => {
		expect(parseToolArguments('')).toEqual({ ok: true, value: {} })
	})

	it("keeps the parser's message, and the position it names", () => {
		expect(parseToolArguments('{"a":1,}')).toEqual({
			ok: false,
			parseError: 'Expected double-quoted property name in JSON at position 7 (line 1 column 8)',
			offset: 7,
		})
	})

	it.each([
		['{"a": True}', 6],
		['{"a": None}', 6],
		['{"a": NaN}', 6],
		['{"a": undefined}', 6],
		['{"a":[1,]}', 8],
	])('locates %s, whose error names no position, at %i', (text, offset) => {
		// Python's and JavaScript's literals, the common slip: V8 only quotes the
		// text around the token, so the offset used to be left out.
		const parsed = parseToolArguments(text)
		expect(parsed).toMatchObject({ ok: false, offset })
		expect(parsed.ok || parsed.parseError).not.toMatch(/position/)
	})

	it('locates a bare token deep in a long input, where the quoted text is cut short', () => {
		const text = `{"content":"${'x'.repeat(5_000)}","done":True}`
		expect(parseToolArguments(text)).toMatchObject({ ok: false, offset: text.indexOf('True') })
	})

	it('reports the length when the text ended before its value did', () => {
		expect(parseToolArguments('{"a":"b')).toMatchObject({ ok: false, offset: 7 })
		expect(parseToolArguments('{"a":tr')).toMatchObject({ ok: false, offset: 7 })
	})
})

describe('jsonSyntaxErrorOffset', () => {
	it('finds nothing wrong with valid JSON', () => {
		for (const text of ['{}', ' [1, -0.5e+3, "a\\u00e9\\n", true, false, null] ', '"x"', '0']) {
			expect(jsonSyntaxErrorOffset(text)).toBeUndefined()
		}
	})

	it('survives nesting deeper than a recursive parser would', () => {
		const text = `${'['.repeat(100_000)}${']'.repeat(99_999)}`
		expect(jsonSyntaxErrorOffset(text)).toBe(text.length)
	})

	it('agrees with every position the parser names, on mangled JSON', () => {
		// Deterministic: random edits to valid JSON, compared with V8 wherever
		// its message names a position, and with its verdict on validity.
		let seed = 7
		const random = () => {
			seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff
			return seed / 0x7fffffff
		}
		const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T
		const noise = [
			'{',
			'}',
			'[',
			']',
			':',
			',',
			'"',
			'\\',
			'1',
			'0',
			'-',
			'.',
			'e',
			'+',
			't',
			'n',
			' ',
			'\n',
			'T',
			'x',
			'\u0001',
		]
		const samples = [
			{ path: 'a.md', content: 'line one\nline "two"\\', replace_all: false, n: -1.5e-3 },
			[1, [2, { three: null }], 'four', true],
			{ question: 'Which one?', options: ['a', 'b'], nested: { deep: [0, {}] } },
		]
		let compared = 0
		for (let round = 0; round < 3_000; round++) {
			let text = JSON.stringify(pick(samples))
			for (let edit = Math.floor(random() * 3); edit >= 0; edit--) {
				const at = Math.floor(random() * (text.length + 1))
				const kind = random()
				if (kind < 0.4) text = text.slice(0, at) + pick(noise) + text.slice(at)
				else if (kind < 0.8) text = text.slice(0, at) + text.slice(at + 1)
				else text = text.slice(0, at)
			}
			let message: string | undefined
			try {
				JSON.parse(text)
			} catch (err) {
				message = (err as Error).message
			}
			const offset = jsonSyntaxErrorOffset(text)
			expect(offset === undefined, text).toBe(message === undefined)
			const named = message === undefined ? undefined : /\bposition (\d+)/.exec(message)?.[1]
			if (named !== undefined) {
				expect(offset, text).toBe(Number(named))
				compared++
			}
		}
		expect(compared).toBeGreaterThan(500)
	})
})

describe('classifyUnreadableToolInput', () => {
	const failure = { parseError: 'Unterminated string in JSON at position 5', offset: 5 }

	const last = { length: 6, precedingLength: 0, last: true }

	it.each([
		['length', 'truncated'],
		['content_filter', 'truncated'],
		[undefined, 'truncated'],
		['tool_calls', 'malformed'],
		['stop', 'malformed'],
	] as const)('reads finish reason %s on the last call as %s', (finishReason, reason) => {
		expect(classifyUnreadableToolInput(failure, last, finishReason).reason).toBe(reason)
	})

	it.each(['length', 'content_filter', undefined, 'tool_calls', 'stop'] as const)(
		'reads a call the model moved on from as malformed, on finish reason %s',
		(finishReason) => {
			// Whatever stopped the response stopped it after this call was done.
			const earlier = { length: 6, precedingLength: 0, last: false }
			expect(classifyUnreadableToolInput(failure, earlier, finishReason)).toMatchObject({
				reason: 'malformed',
				length: 6,
				precedingLength: 0,
			})
		},
	)
})

describe('capPartialArguments', () => {
	it('leaves a short buffer whole', () => {
		expect(capPartialArguments('{"a":')).toBe('{"a":')
	})

	it('never ends on half of a surrogate pair', () => {
		const buffer = `${'x'.repeat(PARTIAL_ARGUMENTS_EVENT_LIMIT - 1)}😀tail`
		const capped = capPartialArguments(buffer)
		expect(capped).toBe('x'.repeat(PARTIAL_ARGUMENTS_EVENT_LIMIT - 1))
	})
})
