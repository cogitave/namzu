import { render } from 'ink-testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Composer, ESC_CLEAR_WINDOW_MS } from '../Composer.js'
import type { Notice } from '../notifications.js'

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
	const harness = render(
		<Composer
			history={[]}
			onSubmit={vi.fn()}
			onFooterNotice={(notice) => notices.push(notice)}
			onFooterNoticeRemove={(key) => removed.push(key)}
			{...overrides}
		/>,
	)
	mounted.push(harness)
	return { ...harness, notices, removed }
}

describe('Esc on a typed draft', () => {
	it('keeps the draft and offers the second Esc as an immediate notice', async () => {
		const h = open()
		h.stdin.write('half a thought')
		await settle()
		h.stdin.write('\x1B')
		await settle()
		expect(h.lastFrame()).toContain('half a thought')
		expect(h.notices).toHaveLength(1)
		expect(h.notices[0]).toMatchObject({
			key: 'escape-again-to-clear',
			text: 'Esc again to clear',
			priority: 'immediate',
			timeoutMs: ESC_CLEAR_WINDOW_MS,
		})
	})

	it('clears on the second Esc inside the window and takes the notice back', async () => {
		const h = open()
		h.stdin.write('half a thought')
		await settle()
		h.stdin.write('\x1B')
		await settle()
		h.stdin.write('\x1B')
		await settle()
		expect(h.lastFrame()).not.toContain('half a thought')
		expect(h.removed).toEqual(['escape-again-to-clear'])
	})

	it('hands the cleared text over, and Up brings it back from the history', async () => {
		const cleared: string[] = []
		const history: string[] = []
		const view = (list: readonly string[]) => (
			<Composer history={list} onSubmit={vi.fn()} onClearedDraft={(text) => cleared.push(text)} />
		)
		const h = render(view(history))
		mounted.push(h)
		h.stdin.write('half a thought')
		await settle()
		h.stdin.write('\x1B')
		await settle()
		h.stdin.write('\x1B')
		await settle()
		expect(cleared).toEqual(['half a thought'])
		expect(h.lastFrame()).not.toContain('half a thought')
		h.rerender(view([...history, ...cleared]))
		await settle()
		h.stdin.write('\x1B[A')
		await settle()
		expect(h.lastFrame()).toContain('half a thought')
	})

	it('does not record a blank draft', async () => {
		const cleared: string[] = []
		const h = open({ onClearedDraft: (text: string) => cleared.push(text) })
		h.stdin.write('   ')
		await settle()
		h.stdin.write('\x1B')
		await settle()
		h.stdin.write('\x1B')
		await settle()
		expect(cleared).toEqual([])
	})

	it('keeps the draft and arms again when the second Esc comes after the window', async () => {
		const h = open()
		h.stdin.write('half a thought')
		await settle()
		h.stdin.write('\x1B')
		await settle()
		await vi.advanceTimersByTimeAsync(ESC_CLEAR_WINDOW_MS)
		h.stdin.write('\x1B')
		await settle()
		expect(h.lastFrame()).toContain('half a thought')
		expect(h.notices).toHaveLength(2)
		expect(h.removed).toEqual([])
	})

	it('leaves Esc to a running turn', async () => {
		const h = open({ escapeInterrupts: true })
		h.stdin.write('half a thought')
		await settle()
		h.stdin.write('\x1B')
		await settle()
		h.stdin.write('\x1B')
		await settle()
		expect(h.lastFrame()).toContain('half a thought')
		expect(h.notices).toEqual([])
	})
})
