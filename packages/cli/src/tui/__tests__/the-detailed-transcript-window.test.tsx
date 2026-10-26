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
	it('shows the last 30 rows under a divider that counts the older ones', async () => {
		const { lastFrame } = open(45)
		const frame = lastFrame() ?? ''
		expect(frame).toContain('ctrl+e to show 15 previous messages')
		expect(frame).not.toContain('row-14-end')
		expect(frame).toContain('row-15-end')
		expect(frame).toContain('row-44-end')
	})

	it('shows all of them after Ctrl+E, and the divider offers to hide them', async () => {
		const { lastFrame, stdin } = open(45)
		stdin.write('\x05')
		await vi.waitFor(() =>
			expect(lastFrame() ?? '').toContain('ctrl+e to hide 15 previous messages'),
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
