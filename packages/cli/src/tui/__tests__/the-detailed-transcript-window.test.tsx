/** The window rule and its divider, through the component. */

import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TranscriptScreen } from '../TranscriptScreen.js'
import type { TranscriptMessage } from '../types.js'

const mounted: { unmount: () => void }[] = []
afterEach(() => {
	for (const h of mounted) h.unmount()
	mounted.length = 0
})

const conversation = (n: number): TranscriptMessage[] =>
	Array.from({ length: n }, (_, i) => ({ id: `m${i}`, role: 'user', content: `row-${i}-end` }))

function open(n: number) {
	const harness = render(
		<TranscriptScreen
			messages={conversation(n)}
			pending={null}
			rows={200}
			columns={80}
			dialogWaiting={false}
			onClose={() => {}}
		/>,
	)
	mounted.push(harness)
	return harness
}

describe('the detailed transcript window', () => {
	it('shows a conversation whole from the start, however far past the tail it goes', async () => {
		const { lastFrame } = open(45)
		const frame = lastFrame() ?? ''
		expect(frame).toContain('row-0-end')
		expect(frame).toContain('row-14-end')
		expect(frame).toContain('row-44-end')
		expect(frame).toContain('ctrl+e to hide 15 previous messages')
	})

	it('shows the last 30 rows of a very long conversation under a divider that counts the older ones', async () => {
		const { lastFrame } = open(250)
		const frame = lastFrame() ?? ''
		expect(frame).toContain('ctrl+e to show 220 previous messages')
		expect(frame).not.toContain('row-189-end')
		expect(frame).toContain('row-220-end')
		expect(frame).toContain('row-249-end')
	})

	it('shows all of a very long one after Ctrl+E, and the divider offers to hide them', async () => {
		const { lastFrame, stdin } = open(250)
		stdin.write('\x05')
		await vi.waitFor(() => expect(lastFrame() ?? '').toContain('ctrl+e to collapse'))
		// All of it is more than the screen holds: `g` goes to the top, where the divider is.
		stdin.write('g')
		await vi.waitFor(() =>
			expect(lastFrame() ?? '').toContain('ctrl+e to hide 220 previous messages'),
		)
		const frame = lastFrame() ?? ''
		expect(frame).toContain('row-0-end')
		expect(frame).toContain('ctrl+e to collapse')
	})

	it('has no divider when every row fits', () => {
		const { lastFrame } = open(30)
		expect(lastFrame() ?? '').not.toContain('previous messages')
	})
})
