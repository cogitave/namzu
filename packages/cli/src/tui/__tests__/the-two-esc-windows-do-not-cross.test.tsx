/**
 * Esc has two double-press windows, both 800 ms: on a typed draft the second
 * Esc clears it, on an empty composer the second Esc opens the rewind picker.
 * Whatever happens between two presses, a press is never counted toward the
 * other window or toward a window an earlier key already ended. The clock is
 * faked; nothing here waits.
 */

import { render } from 'ink-testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Composer, ESC_CLEAR_WINDOW_MS, REWIND_DOUBLE_ESC_MS } from '../Composer.js'
import type { Notice } from '../notifications.js'

const ESC = '\x1B'
const BACKSPACE = '\x7f'
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
	const removed: string[] = []
	const cleared: string[] = []
	const onEditPrevious = vi.fn()
	const harness = render(
		<Composer
			history={[]}
			onSubmit={vi.fn()}
			onEditPrevious={onEditPrevious}
			onFooterNotice={(notice) => notices.push(notice)}
			onFooterNoticeRemove={(key) => removed.push(key)}
			onClearedDraft={(text) => cleared.push(text)}
			{...overrides}
		/>,
	)
	mounted.push(harness)
	return { ...harness, notices, removed, cleared, onEditPrevious }
}

describe('the window on a typed draft', () => {
	it('is a first press again after another key, so the draft survives', async () => {
		const h = open()
		h.stdin.write('half')
		await settle()
		h.stdin.write(ESC)
		await settle()
		h.stdin.write(' a thought')
		await settle()
		expect(h.removed, 'typing took the notice back').toEqual(['escape-again-to-clear'])
		h.stdin.write(ESC)
		await settle()
		expect(h.lastFrame()).toContain('half a thought')
		expect(h.cleared).toEqual([])
		expect(h.notices.map((n) => n.text)).toEqual(['Esc again to clear', 'Esc again to clear'])
		expect(h.onEditPrevious).not.toHaveBeenCalled()
	})

	it('is a first press again after a paste, so the pasted text survives', async () => {
		const h = open()
		h.stdin.write('x')
		await settle()
		h.stdin.write(ESC)
		await settle()
		h.stdin.write('\x1b[200~ pasted\x1b[201~')
		await settle()
		expect(h.removed, 'the paste took the notice back').toEqual(['escape-again-to-clear'])
		h.stdin.write(ESC)
		await settle()
		expect(h.lastFrame()).toContain('x pasted')
		expect(h.cleared).toEqual([])
		expect(h.notices.map((n) => n.text)).toEqual(['Esc again to clear', 'Esc again to clear'])
	})

	it('never opens the rewind picker, even when deleting the draft empties the box', async () => {
		const h = open()
		h.stdin.write('x')
		await settle()
		h.stdin.write(ESC)
		await settle()
		h.stdin.write(BACKSPACE)
		await settle()
		// The box is empty now: this is the first press of the other window.
		h.stdin.write(ESC)
		await settle()
		expect(h.onEditPrevious).not.toHaveBeenCalled()
		expect(h.cleared).toEqual([])
		h.stdin.write(ESC)
		await settle()
		expect(h.onEditPrevious).toHaveBeenCalledTimes(1)
	})

	it('leaves the press after a clear as the first press of the rewind window', async () => {
		const h = open()
		h.stdin.write('draft')
		await settle()
		h.stdin.write(ESC)
		await settle()
		h.stdin.write(ESC)
		await settle()
		expect(h.cleared).toEqual(['draft'])
		h.stdin.write(ESC)
		await settle()
		expect(h.onEditPrevious).not.toHaveBeenCalled()
		expect(h.notices).toHaveLength(1)
		h.stdin.write(ESC)
		await settle()
		expect(h.onEditPrevious).toHaveBeenCalledTimes(1)
	})
})

describe('the window on an empty composer', () => {
	it('shows nothing on the first press and opens on the second inside the window', async () => {
		const h = open()
		h.stdin.write(ESC)
		await settle()
		expect(h.notices).toEqual([])
		expect(h.lastFrame()).not.toContain('Esc again')
		await vi.advanceTimersByTimeAsync(REWIND_DOUBLE_ESC_MS - 100)
		h.stdin.write(ESC)
		await settle()
		expect(h.onEditPrevious).toHaveBeenCalledTimes(1)
	})

	it('is a first press again after the window, and after another key', async () => {
		const h = open()
		h.stdin.write(ESC)
		await vi.advanceTimersByTimeAsync(REWIND_DOUBLE_ESC_MS + 1)
		h.stdin.write(ESC)
		await settle()
		expect(h.onEditPrevious).not.toHaveBeenCalled()
		h.stdin.write('x')
		await settle()
		// A draft now: the next Esc is the first press of the clear window.
		h.stdin.write(ESC)
		await settle()
		expect(h.onEditPrevious).not.toHaveBeenCalled()
		expect(h.cleared).toEqual([])
		expect(h.lastFrame()).toContain('x')
		expect(h.notices.map((n) => n.text)).toEqual(['Esc again to clear'])
	})

	it('does not count a press that was the first of the clear window', async () => {
		const h = open()
		h.stdin.write('hi')
		await settle()
		h.stdin.write(ESC)
		await vi.advanceTimersByTimeAsync(ESC_CLEAR_WINDOW_MS + 1)
		h.stdin.write(BACKSPACE)
		h.stdin.write(BACKSPACE)
		await settle()
		h.stdin.write(ESC)
		await settle()
		expect(h.onEditPrevious).not.toHaveBeenCalled()
	})
})

describe('while a reply runs', () => {
	it('leaves Esc alone for the interrupt, whatever is typed', async () => {
		const h = open({ escapeInterrupts: true })
		h.stdin.write(ESC)
		await settle()
		h.stdin.write(ESC)
		await settle()
		h.stdin.write('typed')
		await settle()
		h.stdin.write(ESC)
		await settle()
		h.stdin.write(ESC)
		await settle()
		expect(h.onEditPrevious).not.toHaveBeenCalled()
		expect(h.notices).toEqual([])
		expect(h.lastFrame()).toContain('typed')
	})
})
