/**
 * Esc on an open suggestion menu closes the menu and nothing else: the draft
 * stays, no clear notice shows, and the clear window is not armed. In a
 * history search Esc keeps the match in the box and Ctrl+C goes back to the
 * earlier draft. The clock is faked; nothing here waits.
 */

import { render } from 'ink-testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Composer, ESC_CLEAR_WINDOW_MS } from '../Composer.js'
import type { Notice } from '../notifications.js'

const ESC = '\x1B'
const CTRL_C = '\x03'
const CTRL_R = '\x12'
const mounted: { unmount: () => void }[] = []
const settle = () => vi.advanceTimersByTimeAsync(30)

beforeEach(() => {
	vi.useFakeTimers()
})
afterEach(() => {
	for (const harness of mounted) harness.unmount()
	mounted.length = 0
	vi.useRealTimers()
})

function open(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
	const notices: Notice[] = []
	const cleared: string[] = []
	const searching: boolean[] = []
	const harness = render(
		<Composer
			history={[]}
			mentionCandidates={['src/review.ts', 'src/render.ts']}
			onSubmit={vi.fn()}
			onFooterNotice={(notice) => notices.push(notice)}
			onClearedDraft={(text) => cleared.push(text)}
			onHistorySearchChange={(on) => searching.push(on)}
			{...overrides}
		/>,
	)
	mounted.push(harness)
	return { ...harness, notices, cleared, searching }
}

describe('Esc on an open slash menu', () => {
	it('closes the menu, keeps the draft and shows no clear notice', async () => {
		const h = open()
		h.stdin.write('/mo')
		await settle()
		expect(h.lastFrame()).toContain('/model')
		h.stdin.write(ESC)
		await settle()
		expect(h.lastFrame()).not.toContain('/model ')
		expect(h.lastFrame()).toContain('/mo')
		expect(h.notices).toEqual([])
	})

	it('leaves the clear window unarmed: the next Esc behaves as for a plain draft', async () => {
		const h = open()
		h.stdin.write('/mo')
		await settle()
		h.stdin.write(ESC)
		await settle()
		h.stdin.write(ESC)
		await settle()
		expect(h.cleared, 'one Esc after the menu closed does not clear').toEqual([])
		expect(h.notices).toHaveLength(1)
		expect(h.notices[0]?.text).toBe('Esc again to clear')
		h.stdin.write(ESC)
		await settle()
		expect(h.cleared).toEqual(['/mo'])
		expect(h.lastFrame()).not.toContain('/mo')
	})

	it('opens the menu again on the next edit', async () => {
		const h = open()
		h.stdin.write('/mo')
		await settle()
		h.stdin.write(ESC)
		await settle()
		h.stdin.write('d')
		await settle()
		expect(h.lastFrame()).toContain('/model')
	})

	it('does not let the first Esc and a later one inside the window count as a pair', async () => {
		const h = open()
		h.stdin.write('/mo')
		await settle()
		h.stdin.write(ESC)
		await vi.advanceTimersByTimeAsync(ESC_CLEAR_WINDOW_MS - 100)
		h.stdin.write(ESC)
		await settle()
		expect(h.cleared).toEqual([])
	})
})

describe('Tab after Esc closed a menu', () => {
	it('brings the menu back and does not send the half-typed command', async () => {
		const onSubmit = vi.fn()
		const h = open({ onSubmit })
		h.stdin.write('/mo')
		await settle()
		h.stdin.write(ESC)
		await settle()
		h.stdin.write('\t')
		await settle()
		expect(onSubmit).not.toHaveBeenCalled()
		expect(h.lastFrame()).toContain('/model')
	})
})

describe('Esc on an open @ menu', () => {
	it('closes the menu and keeps the draft', async () => {
		const h = open()
		h.stdin.write('look at @src/re')
		await settle()
		expect(h.lastFrame()).toContain('src/review.ts')
		h.stdin.write(ESC)
		await settle()
		expect(h.lastFrame()).not.toContain('src/review.ts')
		expect(h.lastFrame()).toContain('look at @src/re')
		expect(h.notices).toEqual([])
		h.stdin.write(ESC)
		await settle()
		expect(h.notices).toHaveLength(1)
		expect(h.cleared).toEqual([])
	})
})

describe('Ctrl+R history search', () => {
	const history = ['fix the build', 'write the docs']

	it('Esc leaves the search with the found text in the box', async () => {
		const h = open({ history })
		h.stdin.write('docs')
		await settle()
		h.stdin.write(CTRL_R)
		await settle()
		expect(h.lastFrame()).toContain('write the docs')
		expect(h.lastFrame()).toContain('Esc keep · Ctrl+C restore')
		h.stdin.write(ESC)
		await settle()
		expect(h.lastFrame()).toContain('write the docs')
		expect(h.lastFrame()).not.toContain('history “')
		expect(h.searching.at(-1)).toBe(false)
	})

	it('Ctrl+C goes back to the draft that was there before', async () => {
		const h = open({ history })
		h.stdin.write('docs')
		await settle()
		h.stdin.write(CTRL_R)
		await settle()
		expect(h.searching.at(-1)).toBe(true)
		h.stdin.write(CTRL_C)
		await settle()
		expect(h.lastFrame()).not.toContain('write the docs')
		expect(h.lastFrame()).toContain('docs')
		expect(h.lastFrame()).not.toContain('history “')
	})
})

describe('A composer that goes away during a search', () => {
	it('tells the app the search is over', async () => {
		const h = open({ history: ['write the docs'] })
		h.stdin.write('docs')
		await settle()
		h.stdin.write(CTRL_R)
		await settle()
		expect(h.searching.at(-1)).toBe(true)
		h.unmount()
		expect(h.searching.at(-1)).toBe(false)
	})
})
