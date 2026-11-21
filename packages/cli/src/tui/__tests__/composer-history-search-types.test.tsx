import { render } from 'ink-testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Composer } from '../Composer.js'

/**
 * Ctrl+R opens a search whose query is what the box held; typing and Backspace
 * then edit the query (the box shows the newest match), Enter sends the match,
 * Esc keeps it in the box and Backspace on an empty query leaves the search.
 */

const mounted: { unmount: () => void }[] = []
const settle = () => vi.advanceTimersByTimeAsync(70)
const CTRL_R = '\x12'
const ESC = '\x1b'

beforeEach(() => {
	vi.useFakeTimers()
})
afterEach(() => {
	for (const harness of mounted) harness.unmount()
	mounted.length = 0
	vi.useRealTimers()
})

function open() {
	const onSubmit = vi.fn()
	const harness = render(
		<Composer history={['fix the login', 'add tests', 'fix the footer']} onSubmit={onSubmit} />,
	)
	mounted.push(harness)
	const send = async (bytes: string) => {
		harness.stdin.write(bytes)
		await settle()
	}
	const keys = async (text: string) => {
		for (const ch of text) await send(ch)
	}
	return { ...harness, onSubmit, send, keys }
}

describe('typing while the history search is open', () => {
	it('edits the query instead of closing the search', async () => {
		const h = open()
		await h.send(CTRL_R)
		expect(h.lastFrame()).toContain('history “”')
		await h.keys('fix')
		expect(h.lastFrame()).toContain('history “fix” · 1/2')
		expect(h.lastFrame()).toContain('fix the footer')
		await h.keys(' the l')
		expect(h.lastFrame()).toContain('history “fix the l” · 1/1')
		expect(h.lastFrame()).toContain('fix the login')
		await h.send('\x7f')
		await h.send('\x7f')
		expect(h.lastFrame()).toContain('history “fix the” · 1/2')
	})

	it('Enter sends the match, Esc keeps it in the box', async () => {
		const h = open()
		await h.send(CTRL_R)
		await h.keys('tests')
		await h.send('\r')
		expect(h.onSubmit.mock.calls[0]?.[0]).toBe('add tests')

		const k = open()
		await k.send(CTRL_R)
		await k.keys('login')
		await k.send(ESC)
		expect(k.lastFrame()).not.toContain('history “')
		expect(k.lastFrame()).toContain('fix the login')
		expect(k.onSubmit).not.toHaveBeenCalled()
	})

	it('Backspace on an empty query leaves the search with the draft back', async () => {
		const h = open()
		await h.send(CTRL_R)
		await h.send('\x7f')
		expect(h.lastFrame()).not.toContain('history “')
	})
})
