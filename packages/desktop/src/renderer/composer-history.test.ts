import { describe, expect, it } from 'vitest'
import {
	HISTORY_LIMIT,
	type HistoryWalk,
	activeWalk,
	caretAfterStep,
	caretAtEdge,
	historyCounter,
	historyEntries,
	stepHistory,
} from './composer-history.js'

const user = (text: string) => ({ role: 'user' as const, text })
const reply = (text: string) => ({ role: 'assistant' as const, text })

describe('historyEntries', () => {
	it('keeps only what the person sent, oldest first', () => {
		expect(historyEntries([user('one'), reply('a'), user('two'), reply('b')])).toEqual([
			'one',
			'two',
		])
	})

	it('drops empty messages and a message sent twice in a row', () => {
		expect(
			historyEntries([user('one'), user('  '), user('one'), user('two'), user('one')]),
		).toEqual(['one', 'two', 'one'])
	})

	it('keeps the newest few', () => {
		const many = Array.from({ length: HISTORY_LIMIT + 5 }, (_, index) => user(`m${index}`))
		const entries = historyEntries(many)
		expect(entries).toHaveLength(HISTORY_LIMIT)
		expect(entries.at(-1)).toBe(`m${HISTORY_LIMIT + 4}`)
	})
})

describe('stepHistory', () => {
	const entries = ['first', 'second', 'third']

	it('has nowhere to go without history, or coming down with no walk', () => {
		expect(stepHistory([], null, '', 'older')).toBeNull()
		expect(stepHistory(entries, null, 'x', 'newer')).toBeNull()
	})

	it('starts at the newest message and keeps what was typed', () => {
		const step = stepHistory(entries, null, 'half a thought', 'older')
		expect(step?.text).toBe('third')
		expect(step?.walk).toEqual({ index: 2, stash: 'half a thought', recalled: 'third' })
	})

	it('walks back, stops at the oldest, and walks forward again', () => {
		let draft = ''
		let walk: HistoryWalk | null = null
		const go = (direction: 'older' | 'newer') => {
			const step = stepHistory(entries, walk, draft, direction)
			if (step) {
				walk = step.walk
				draft = step.text
			}
			return step
		}
		expect(go('older')?.text).toBe('third')
		expect(go('older')?.text).toBe('second')
		expect(go('older')?.text).toBe('first')
		expect(go('older')).toBeNull()
		expect(draft).toBe('first')
		expect(go('newer')?.text).toBe('second')
		expect(go('newer')?.text).toBe('third')
	})

	it('hands back the unsent draft when it comes down past the newest message', () => {
		const down = stepHistory(
			entries,
			{ index: 2, stash: 'my draft', recalled: 'third' },
			'third',
			'newer',
		)
		expect(down).toEqual({ walk: null, text: 'my draft' })
	})

	it('ignores a walk the person has typed over', () => {
		const walk = { index: 1, stash: '', recalled: 'second' }
		expect(activeWalk(walk, 'second')).toBe(walk)
		expect(activeWalk(walk, 'second, edited')).toBeNull()
		// Typing over a recalled message and going up starts a fresh walk from the newest message.
		expect(stepHistory(entries, walk, 'second, edited', 'older')?.text).toBe('third')
	})

	it('counts back from the newest message', () => {
		expect(historyCounter({ index: 2, stash: '', recalled: '' }, 3)).toBe('Earlier message 1 of 3')
		expect(historyCounter({ index: 0, stash: '', recalled: '' }, 3)).toBe('Earlier message 3 of 3')
	})
})

describe('caretAtEdge', () => {
	it('lets up recall into an empty box or from the very start of the text', () => {
		expect(caretAtEdge('', 0, 0, 'older')).toBe(true)
		expect(caretAtEdge('typed', 0, 0, 'older')).toBe(true)
		expect(caretAtEdge('typed', 5, 5, 'older')).toBe(false)
	})

	it('moves the caret first in text of several lines', () => {
		expect(caretAtEdge('one\ntwo', 6, 6, 'older')).toBe(false)
		expect(caretAtEdge('one\ntwo', 2, 2, 'older')).toBe(false)
		expect(caretAtEdge('one\ntwo', 2, 2, 'newer')).toBe(false)
		expect(caretAtEdge('one\ntwo', 7, 7, 'newer')).toBe(true)
	})

	it('leaves the caret to the box inside one long wrapped paragraph', () => {
		const paragraph = 'word '.repeat(120).trim()
		// The caret at the end of a recalled paragraph is on its last wrapped row: Up moves it a row.
		expect(caretAtEdge(paragraph, paragraph.length, paragraph.length, 'older')).toBe(false)
		expect(caretAtEdge(paragraph, 200, 200, 'older')).toBe(false)
		expect(caretAtEdge(paragraph, 0, 0, 'older')).toBe(true)
		// Down from the middle of it moves the caret a row instead of jumping to the newer message.
		expect(caretAtEdge(paragraph, 200, 200, 'newer')).toBe(false)
		expect(caretAtEdge(paragraph, paragraph.length, paragraph.length, 'newer')).toBe(true)
	})

	it('leaves a selection alone', () => {
		expect(caretAtEdge('typed', 0, 3, 'older')).toBe(false)
		expect(caretAtEdge('typed', 1, 5, 'newer')).toBe(false)
	})
})

describe('caretAfterStep', () => {
	it('puts the caret at the start after an older message and at the end after a newer one', () => {
		expect(caretAfterStep('some text', 'older')).toBe(0)
		expect(caretAfterStep('some text', 'newer')).toBe(9)
	})
})
