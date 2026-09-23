/**
 * While a question for the operator is on screen — a job's confirmation, a
 * Continue card, a review — the Working row says it is waiting for them, and
 * that wait is not counted in the turn's time.
 */

import { render } from 'ink-testing-library'
import { afterEach, expect, it, vi } from 'vitest'

import { LiveActivity } from '../LiveActivity.js'

afterEach(() => {
	vi.useRealTimers()
})

it('says it waits for you instead of counting, and leaves the wait out of the time', () => {
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(new Date('2026-09-23T19:00:00Z'))
	const view = render(<LiveActivity activeTools={[]} working interruptible animate={false} />)
	try {
		vi.setSystemTime(new Date('2026-09-23T19:00:05Z'))
		view.rerender(
			<LiveActivity activeTools={[]} working interruptible animate={false} waitingForYou />,
		)
		const waiting = view.lastFrame() ?? ''
		expect(waiting).toContain('Waiting for you')
		expect(waiting).not.toContain('Working')
		expect(waiting).not.toContain('esc to interrupt')
		// A minute and a half at the question.
		vi.setSystemTime(new Date('2026-09-23T19:01:35Z'))
		view.rerender(<LiveActivity activeTools={[]} working interruptible animate={false} />)
		vi.setSystemTime(new Date('2026-09-23T19:01:37Z'))
		view.rerender(<LiveActivity activeTools={[]} working interruptible animate={false} />)
		const after = view.lastFrame() ?? ''
		expect(after).toContain('Working')
		expect(after).toContain("(7.0s")
	} finally {
		view.unmount()
	}
})
