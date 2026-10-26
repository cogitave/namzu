import { Text } from 'ink'
import { render } from 'ink-testing-library'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TITLE_ANIMATION_MS } from './terminal-title.js'
import { useTitleFrame } from './title-frame.js'

function Frame({ active }: { readonly active: boolean }) {
	return <Text>frame:{useTitleFrame(active)}</Text>
}

describe('the title frame counter', () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it('advances every period while active and freezes when it stops', async () => {
		const view = render(<Frame active />)
		expect(view.lastFrame()).toBe('frame:0')
		await act(async () => {
			vi.advanceTimersByTime(TITLE_ANIMATION_MS)
		})
		expect(view.lastFrame()).toBe('frame:1')
		await act(async () => {
			vi.advanceTimersByTime(TITLE_ANIMATION_MS)
		})
		expect(view.lastFrame()).toBe('frame:2')

		view.rerender(<Frame active={false} />)
		await act(async () => {
			vi.advanceTimersByTime(TITLE_ANIMATION_MS * 5)
		})
		expect(view.lastFrame()).toBe('frame:2')

		view.rerender(<Frame active />)
		await act(async () => {
			vi.advanceTimersByTime(TITLE_ANIMATION_MS)
		})
		expect(view.lastFrame()).toBe('frame:3')
		view.unmount()
	})
})
