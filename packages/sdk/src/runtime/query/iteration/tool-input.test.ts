import { describe, expect, it } from 'vitest'

import {
	PARTIAL_ARGUMENTS_EVENT_LIMIT,
	capPartialArguments,
	classifyUnreadableToolInput,
	parseToolArguments,
} from './tool-input.js'

describe('parseToolArguments', () => {
	it('reads an empty buffer as no arguments', () => {
		expect(parseToolArguments('')).toEqual({ ok: true, value: {} })
	})

	it("keeps the parser's message and its position", () => {
		expect(parseToolArguments('{"a":1,}')).toEqual({
			ok: false,
			parseError: 'Expected double-quoted property name in JSON at position 7 (line 1 column 8)',
			offset: 7,
		})
	})

	it('reports no offset when the parser quotes text instead of naming a position', () => {
		const parsed = parseToolArguments('{"a": x}')
		expect(parsed.ok).toBe(false)
		expect(parsed).not.toHaveProperty('offset')
	})
})

describe('classifyUnreadableToolInput', () => {
	const failure = { parseError: 'Unterminated string in JSON at position 5', offset: 5 }

	it.each([
		['length', 'truncated'],
		['content_filter', 'truncated'],
		[undefined, 'truncated'],
		['tool_calls', 'malformed'],
		['stop', 'malformed'],
	] as const)('reads finish reason %s as %s', (finishReason, reason) => {
		expect(
			classifyUnreadableToolInput(failure, { length: 6, responseLength: 6 }, finishReason).reason,
		).toBe(reason)
	})
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
