import { describe, expect, it } from 'vitest'
import { fitStatusLine } from '../StatusBar.js'
import { contextMeter } from '../context-meter.js'

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

describe('the meter in the footer', () => {
	function layout(columns: number, context: string | null) {
		return fitStatusLine({
			columns,
			provider: null,
			model: 'claude-haiku-4-5',
			modeLabel: '⏵⏵ accept edits on',
			cycleSuffix: ' (shift+tab to cycle)',
			effort: 'high',
			interrupt: 'esc to interrupt',
			context,
		})
	}

	it('sits after the effort and before the hints', () => {
		const out = layout(200, '12% until auto-compact')
		expect(out.context).toBe('12% until auto-compact')
		expect(out.effort).toBe('effort high')
	})

	it('is dropped after the hints and the cycle key, before the effort', () => {
		const wide = layout(200, '12% until auto-compact')
		const need = (l: ReturnType<typeof layout>) =>
			[l.mode, l.cycleSuffix, l.effort, l.context, l.interrupt].filter(Boolean).join(' · ').length
		// Narrow enough to lose the interrupt hint and the cycle key but not the effort.
		const without = layout(need(wide) - 30, '12% until auto-compact')
		expect(without.interrupt).toBeNull()
		expect(without.cycleSuffix).toBeNull()
		const tighter = layout(50, '12% until auto-compact')
		expect(tighter.context).toBeNull()
		expect(tighter.effort).not.toBeNull()
	})
})
