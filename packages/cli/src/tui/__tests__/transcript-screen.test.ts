import { describe, expect, it } from 'vitest'

import {
	TRANSCRIPT_SCREEN_TAIL,
	screenDivider,
	screenFooter,
	screenWindow,
} from '../transcript-screen.js'
import type { TranscriptMessage } from '../types.js'

const rows = (n: number): TranscriptMessage[] =>
	Array.from({ length: n }, (_, i) => ({ id: `m${i}`, role: 'assistant', content: `row ${i}` }))

describe('the detailed transcript window', () => {
	it('shows the last 30 rows and counts the rest', () => {
		const { hiddenCount, shown } = screenWindow(rows(45), false)
		expect(TRANSCRIPT_SCREEN_TAIL).toBe(30)
		expect(hiddenCount).toBe(15)
		expect(shown).toHaveLength(30)
		expect(shown[0]?.id).toBe('m15')
		expect(shown.at(-1)?.id).toBe('m44')
	})

	it('shows every row once asked, and still says how many were folded away', () => {
		const { hiddenCount, shown } = screenWindow(rows(45), true)
		expect(shown).toHaveLength(45)
		expect(hiddenCount).toBe(15)
	})

	it('has no divider when everything fits', () => {
		const { hiddenCount } = screenWindow(rows(30), false)
		expect(hiddenCount).toBe(0)
		expect(screenDivider(hiddenCount, false)).toBeNull()
		expect(screenDivider(0, true)).toBeNull()
	})

	it('words the divider for show and for hide', () => {
		expect(screenDivider(15, false)).toEqual(['ctrl+e to show ', '15', ' previous messages'])
		expect(screenDivider(15, true)).toEqual(['ctrl+e to hide ', '15', ' previous messages'])
		expect(screenDivider(1, false)?.[2]).toBe(' previous message')
		expect(screenDivider(1200, false)?.[1]).toBe('1,200')
	})
})

describe('the detailed transcript footer', () => {
	it('names the toggles', () => {
		expect(screenFooter({ showAll: false, dialogWaiting: false, columns: 100 })).toEqual({
			prefix: '',
			text: 'Showing detailed transcript · ctrl+o to toggle · ctrl+e to show all',
		})
		expect(screenFooter({ showAll: true, dialogWaiting: false, columns: 100 }).text).toBe(
			'Showing detailed transcript · ctrl+o to toggle · ctrl+e to collapse',
		)
	})

	it('puts the dialog notice in front', () => {
		const { prefix } = screenFooter({ showAll: false, dialogWaiting: true, columns: 100 })
		expect(prefix).toBe('dialog waiting · ')
	})

	it('cuts to the width with an ellipsis', () => {
		const { prefix, text } = screenFooter({ showAll: false, dialogWaiting: true, columns: 40 })
		expect(prefix.length + text.length).toBeLessThanOrEqual(40)
		expect(text.endsWith('…')).toBe(true)
	})
})
