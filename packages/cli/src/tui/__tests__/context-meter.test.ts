import { describe, expect, it } from 'vitest'
import { CONTEXT_NOTICE_KEY, contextMeter, contextNotice } from '../context-meter.js'
import { EMPTY_NOTICES, reduce } from '../notifications.js'

/**
 * The footer says nothing until the context is within 20,000 tokens of the
 * point where the conversation is summarised, then counts down to that point.
 * On a 200,000-token window that point is 167,000 tokens.
 */
describe('the context meter', () => {
	const base = { windowTokens: 200_000, autoCompact: true }

	it('is silent while there is room', () => {
		expect(contextMeter({ ...base, tokens: 100_000 })).toBeNull()
		expect(contextMeter({ ...base, tokens: 146_999 })).toBeNull()
	})

	it('appears 20,000 tokens before the summary point and counts down to it', () => {
		expect(contextMeter({ ...base, tokens: 147_000 })).toEqual({
			text: '12% until auto-compact',
			tone: 'muted',
		})
		expect(contextMeter({ ...base, tokens: 160_000 })?.text).toBe('4% until auto-compact')
	})

	it('bottoms out at 0% rather than going negative', () => {
		expect(contextMeter({ ...base, tokens: 190_000 })?.text).toBe('0% until auto-compact')
	})

	it('measures a small window against its own summary point', () => {
		// 32,000 window: the point is 16,000 (half), the meter starts at once.
		expect(contextMeter({ windowTokens: 32_000, autoCompact: true, tokens: 8_000 })?.text).toBe(
			'50% until auto-compact',
		)
	})

	it('with auto-compact off warns in red against the whole window', () => {
		expect(contextMeter({ windowTokens: 200_000, autoCompact: false, tokens: 185_000 })).toEqual({
			text: 'Context low (8% remaining) · Run /compact to compact & continue',
			tone: 'error',
		})
		expect(contextMeter({ windowTokens: 200_000, autoCompact: false, tokens: 100_000 })).toBeNull()
	})

	it('ignores a window it was not told', () => {
		expect(contextMeter({ windowTokens: 0, autoCompact: true, tokens: 5 })).toBeNull()
	})
})

describe('the meter in the notice slot', () => {
	it('is a medium notice that stays and takes a newer reading in place', () => {
		const first = contextNotice({ text: '12% until auto-compact', tone: 'muted' })
		const second = contextNotice({ text: '11% until auto-compact', tone: 'muted' })
		expect(first.key).toBe(CONTEXT_NOTICE_KEY)
		expect(first.priority).toBe('medium')
		expect(first.timeoutMs).toBeGreaterThan(60 * 60 * 1000)
		const shown = reduce(EMPTY_NOTICES, { type: 'add', notice: first }).state
		expect(shown.current?.text).toBe('12% until auto-compact')
		const folded = reduce(shown, { type: 'add', notice: second })
		expect(folded.state.current?.text).toBe('11% until auto-compact')
		expect(folded.timer).toMatchObject({ kind: 'start', key: CONTEXT_NOTICE_KEY })
	})

	it('is red when nothing will compact', () => {
		expect(contextNotice({ text: 'Context low (5% remaining)', tone: 'error' }).tone).toBe('error')
		expect(contextNotice({ text: '12% until auto-compact', tone: 'muted' }).tone).toBe('dim')
	})
})
