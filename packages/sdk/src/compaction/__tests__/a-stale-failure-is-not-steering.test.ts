import { describe, expect, it } from 'vitest'

import { WorkingStateManager } from '../manager.js'

/**
 * Every list in working state keeps its earliest entries when it has to
 * drop something, because early decisions are load-bearing — the one that
 * set the run's approach outlives twenty-five incidental notes.
 *
 * For failures that reasoning is backwards. The earliest failure is the
 * one the model has most likely already worked around; the recent one is
 * what it reads to decide what to do differently. And a stale failure is
 * not neutral ballast: conditioning a model on its own error-prone history
 * raises the likelihood of further errors (arXiv:2509.09677), so the slot
 * was permanently protecting exactly the entries that hurt.
 */

function managerWith(maxListSize: number, keepFirstEntries: number): WorkingStateManager {
	return new WorkingStateManager({
		maxListSize,
		keepFirstEntries,
		maxToolResults: 30,
	} as never)
}

describe('the failures slot', () => {
	it('drops the oldest failure, not the middle one', () => {
		const m = managerWith(3, 2)
		for (const f of ['first', 'second', 'third', 'fourth']) m.addFailure(f)

		const { failures } = m.getState()

		expect(failures).toEqual(['second', 'third', 'fourth'])
		expect(failures).not.toContain('first')
	})

	it('keeps the most recent failure whatever the list size', () => {
		// The one the comment in `tool-result-editing.ts` is about: the
		// error that steers is the one just seen.
		const m = managerWith(2, 3)
		for (const f of ['a', 'b', 'c', 'd', 'e']) m.addFailure(f)

		expect(m.getState().failures.at(-1)).toBe('e')
	})

	it('still counts what it dropped', () => {
		// A slot that silently shrinks presents a gap as complete.
		const m = managerWith(2, 0)
		for (const f of ['a', 'b', 'c', 'd']) m.addFailure(f)

		expect(m.getState().evicted.failures).toBe(2)
	})
})

describe('every other slot', () => {
	it('still protects its earliest decisions', () => {
		// The change is to one slot, not to the policy. A decision that set
		// the run's approach has to outlive later noise, and breaking that
		// while fixing failures would trade one defect for another.
		const m = managerWith(3, 2)
		for (const d of ['first', 'second', 'third', 'fourth']) m.addDecision(d)

		const { decisions } = m.getState()

		expect(decisions[0]).toBe('first')
		expect(decisions[1]).toBe('second')
		expect(decisions).toContain('fourth')
	})

	it('still protects its earliest discoveries', () => {
		const m = managerWith(3, 2)
		for (const d of ['first', 'second', 'third', 'fourth']) m.addDiscovery(d)

		expect(m.getState().discoveries[0]).toBe('first')
	})
})
