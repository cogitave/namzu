import { render } from 'ink-testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Composer } from '../Composer.js'

/**
 * A backslash right before the cursor turns Enter into a new line, in the
 * plain box and in vim's INSERT mode: the backslash is dropped, nothing is
 * sent. A doubled backslash is an escaped one and Enter sends it.
 */

const mounted: { unmount: () => void }[] = []
// Ink draws at most once per ~33 ms; move the fake clock past a draw before reading a frame.
const settle = () => vi.advanceTimersByTimeAsync(70)

beforeEach(() => {
	vi.useFakeTimers()
})
afterEach(() => {
	for (const harness of mounted) harness.unmount()
	mounted.length = 0
	vi.useRealTimers()
})

function open(editorMode: 'normal' | 'vim') {
	const onSubmit = vi.fn()
	const harness = render(<Composer history={[]} onSubmit={onSubmit} editorMode={editorMode} />)
	mounted.push(harness)
	const keys = async (text: string) => {
		for (const ch of text) {
			harness.stdin.write(ch)
			await settle()
		}
	}
	const send = async (bytes: string) => {
		harness.stdin.write(bytes)
		await settle()
	}
	return { ...harness, onSubmit, keys, send }
}

describe.each(['normal', 'vim'] as const)('a trailing backslash in the %s editor', (mode) => {
	it('Enter drops the backslash, starts a new line and sends nothing', async () => {
		const h = open(mode)
		await h.keys('first\\')
		await h.send('\r')
		expect(h.onSubmit).not.toHaveBeenCalled()
		await h.keys('second')
		const frame = h.lastFrame() ?? ''
		expect(frame).toContain('first')
		expect(frame).toContain('second')
		expect(frame).not.toContain('\\')
		await h.send('\r')
		expect(h.onSubmit).toHaveBeenCalledTimes(1)
		expect(h.onSubmit.mock.calls[0]?.[0]).toBe('first\nsecond')
	})

	it('an escaped backslash pair stays and Enter sends it', async () => {
		const h = open(mode)
		await h.keys('path\\\\')
		await h.send('\r')
		expect(h.onSubmit).toHaveBeenCalledTimes(1)
		expect(h.onSubmit.mock.calls[0]?.[0]).toBe('path\\\\')
	})

	it('three backslashes keep the escaped pair and break the line', async () => {
		const h = open(mode)
		await h.keys('a\\\\\\')
		await h.send('\r')
		expect(h.onSubmit).not.toHaveBeenCalled()
		await h.keys('b')
		await h.send('\r')
		expect(h.onSubmit.mock.calls[0]?.[0]).toBe('a\\\\\nb')
	})
})
