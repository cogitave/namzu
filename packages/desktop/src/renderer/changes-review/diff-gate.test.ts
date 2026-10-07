import { describe, expect, it } from 'vitest'
import {
	RICH_DIFF_MAX_CHANGED_LINES,
	RICH_DIFF_MAX_CHARACTERS,
	gateNotice,
	richDiffVerdict,
} from './diff-gate.js'

const base = { before: 'a', after: 'b', added: 1, removed: 1 }

describe('richDiffVerdict', () => {
	it('keeps the rich view for an ordinary file', () => {
		expect(richDiffVerdict(base)).toEqual({ rich: true })
	})

	it('allows exactly the line limit and gates one line past it', () => {
		const at = { ...base, added: RICH_DIFF_MAX_CHANGED_LINES - 5, removed: 5 }
		expect(richDiffVerdict(at)).toEqual({ rich: true })
		const over = richDiffVerdict({ ...at, removed: 6 })
		expect(over).toMatchObject({ rich: false, reason: 'lines', changedLines: 1_201 })
	})

	it('allows exactly the character limit and gates one past it', () => {
		const half = RICH_DIFF_MAX_CHARACTERS / 2
		const at = { ...base, before: 'x'.repeat(half), after: 'y'.repeat(half) }
		expect(richDiffVerdict(at)).toEqual({ rich: true })
		const over = richDiffVerdict({ ...at, after: 'y'.repeat(half + 1) })
		expect(over).toMatchObject({ rich: false, reason: 'characters' })
	})

	it('counts a missing side as empty', () => {
		expect(richDiffVerdict({ before: null, after: null, added: 0, removed: 0 })).toEqual({
			rich: true,
		})
	})

	it('names the lines first when both limits are passed', () => {
		const both = richDiffVerdict({
			before: 'x'.repeat(RICH_DIFF_MAX_CHARACTERS),
			after: '',
			added: 2_000,
			removed: 0,
		})
		expect(both).toMatchObject({ rich: false, reason: 'lines' })
	})
})

describe('gateNotice', () => {
	it('says what tripped the gate in plain words', () => {
		expect(gateNotice({ rich: false, reason: 'lines', characters: 10, changedLines: 5000 })).toBe(
			'This diff changes 5,000 lines, so it is shown as a plain patch.',
		)
		expect(
			gateNotice({ rich: false, reason: 'characters', characters: 250_400, changedLines: 3 }),
		).toBe('This diff is 250k characters, so it is shown as a plain patch.')
	})
})
