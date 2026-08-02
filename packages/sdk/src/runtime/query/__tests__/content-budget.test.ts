import { describe, expect, it } from 'vitest'

import { describeDroppedContent, measureContentBytes } from '../tool-output-budget.js'

/**
 * The output budget takes `output: string` only, so the rich channel was
 * never bounded — an image block of any size passed untouched on the turn
 * that produced it, and that is the single largest payload a tool result
 * can carry.
 *
 * Worse than uncontrolled cost: when the TEXT half truncated, the rich
 * half was dropped with it, silently. Dropping is correct — the preview is
 * no longer the tool's own payload, so an image alongside it would be
 * illustrating something the model can no longer read — but the model saw
 * a preview and had no way to know an image had ever existed, so it
 * reasoned as though the tool returned text only.
 */

describe('naming what a truncated result took with it', () => {
	it('says what kind of block went, and how many', () => {
		const text = describeDroppedContent([
			{ type: 'text', text: 'summary' },
			{ type: 'image', data: 'aGk=' },
			{ type: 'image', data: 'aGk=' },
		])

		expect(text).toContain('2 image blocks')
		// A fact the agent can act on — ask for a smaller region, re-run
		// against a file — where silence looks like a text-only tool.
		expect(text).toContain('omitted')
	})

	it('uses the singular for one block', () => {
		expect(describeDroppedContent([{ type: 'image', data: 'x' }])).toContain('1 image')
	})

	it('says nothing when there was only text to lose', () => {
		// The ordinary case must add no noise.
		expect(describeDroppedContent([{ type: 'text', text: 'a' }])).toBeUndefined()
	})

	it('says nothing for a result with no rich channel at all', () => {
		expect(describeDroppedContent(undefined)).toBeUndefined()
		expect(describeDroppedContent('just a string')).toBeUndefined()
	})

	it('names an unfamiliar block kind rather than skipping it', () => {
		// An unknown block is still something the model cannot see.
		expect(describeDroppedContent([{ type: 'chart', data: 'x' }])).toContain('chart')
	})

	it('counts a block with no type at all', () => {
		expect(describeDroppedContent([{ data: 'x' }])).toContain('content')
	})
})

describe('measuring the rich channel', () => {
	it('measures the payload, not the block count', () => {
		// One block is the whole cost: a single screenshot is the largest
		// thing a tool result can carry.
		expect(measureContentBytes([{ type: 'image', data: 'x'.repeat(500) }])).toBe(500)
	})

	it('adds every block together', () => {
		expect(
			measureContentBytes([
				{ type: 'text', text: 'ab' },
				{ type: 'image', data: 'xyz' },
			]),
		).toBe(5)
	})

	it('is zero for a result with no rich channel', () => {
		expect(measureContentBytes(undefined)).toBe(0)
		expect(measureContentBytes([])).toBe(0)
	})

	it('ignores a block whose payload is not a string', () => {
		// A malformed block contributes no measurable size rather than
		// throwing inside a budget check.
		expect(measureContentBytes([{ type: 'image', data: { buffer: [] } }])).toBe(0)
	})
})
