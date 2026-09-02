import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import { LiveActivity } from '../LiveActivity.js'

describe('the redrawable Working region', () => {
	it('names only controls and child observation that are actually available', () => {
		const quiet = render(
			<LiveActivity activeTools={[]} working agentCount={2} interruptible={false} animate={false} />,
		)
		try {
			const frame = quiet.lastFrame() ?? ''
			expect(frame).toContain('Working')
			expect(frame).toContain('2 agents')
			expect(frame).toContain('ctrl+t to view')
			expect(frame).not.toContain('esc to interrupt')
		} finally {
			quiet.unmount()
		}

		const interruptible = render(
			<LiveActivity activeTools={[]} working interruptible animate={false} />,
		)
		try {
			expect(interruptible.lastFrame()).toContain('esc to interrupt')
		} finally {
			interruptible.unmount()
		}
	})

	it('caps concurrent tool rows and accounts for the hidden remainder', () => {
		const tools = Array.from({ length: 7 }, (_, index) => ({
			id: `tool-${index}`,
			label: `tool ${index}`,
			startedAt: Date.now(),
		}))
		const harness = render(<LiveActivity activeTools={tools} working animate={false} />)
		try {
			const frame = harness.lastFrame() ?? ''
			expect(frame).toContain('tool 0')
			expect(frame).toContain('tool 2')
			expect(frame).not.toContain('tool 3')
			expect(frame).toContain('+4 more tools')
		} finally {
			harness.unmount()
		}
	})

	it('renders nothing when no turn or tool is active', () => {
		const harness = render(<LiveActivity activeTools={[]} working={false} animate={false} />)
		try {
			expect(harness.lastFrame() ?? '').toBe('')
		} finally {
			harness.unmount()
		}
	})
})

describe('the thinking row', () => {
	it('shows the current line of reasoning under Working, dim, and only while no tool runs', () => {
		const thinking = render(
			<LiveActivity activeTools={[]} working animate={false} thinking="weighing the options" />,
		)
		try {
			expect(thinking.lastFrame() ?? '').toContain('└ thinking · weighing the options')
		} finally {
			thinking.unmount()
		}

		const redacted = render(<LiveActivity activeTools={[]} working animate={false} thinking="" />)
		try {
			expect(redacted.lastFrame() ?? '').toContain('└ thinking…')
		} finally {
			redacted.unmount()
		}

		const busy = render(
			<LiveActivity
				activeTools={[{ id: 't', label: 'bash(ls)', startedAt: Date.now() }]}
				working
				animate={false}
				thinking="stale"
			/>,
		)
		try {
			expect(busy.lastFrame() ?? '').not.toContain('thinking')
		} finally {
			busy.unmount()
		}
	})
})
