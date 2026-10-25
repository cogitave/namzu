import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'

import { LiveActivity } from '../LiveActivity.js'

describe('the redrawable Working region', () => {
	it('names only controls and child observation that are actually available', () => {
		const quiet = render(<LiveActivity activeTools={[]} working agentCount={2} animate={false} />)
		try {
			const frame = quiet.lastFrame() ?? ''
			expect(frame).toContain('Working')
			expect(frame).toContain('2 agents')
			expect(frame).toContain('ctrl+t to view')
			expect(frame).not.toContain('esc to interrupt')
		} finally {
			quiet.unmount()
		}

		// `esc to interrupt` lives in the footer only, never in the spinner row.
		const plain = render(<LiveActivity activeTools={[]} working animate={false} />)
		try {
			expect(plain.lastFrame()).not.toContain('esc to interrupt')
		} finally {
			plain.unmount()
		}
	})

	it('hides the figures group until tokens, thinking, compaction, agents or 16 s', () => {
		const frame = (props: Partial<React.ComponentProps<typeof LiveActivity>>) => {
			const harness = render(<LiveActivity activeTools={[]} working animate={false} {...props} />)
			try {
				return harness.lastFrame() ?? ''
			} finally {
				harness.unmount()
			}
		}
		expect(frame({})).not.toContain('(')
		expect(frame({ tokens: 0 })).not.toContain('(')
		expect(frame({ tokens: 1_100 })).toMatch(/Working \(0s · ↓ 1\.1k tokens\)/u)
		expect(frame({ thinking: '' })).toContain('Working (0s)')
		expect(frame({ compacting: true })).toContain('Working (0s)')
	})

	it('opens the figures group after 16 s and reads the time as 17s, then 1m 23s', () => {
		vi.useFakeTimers({ toFake: ['Date'] })
		try {
			const harness = render(<LiveActivity activeTools={[]} working animate={false} />)
			try {
				expect(harness.lastFrame()).not.toContain('(')
				vi.setSystemTime(Date.now() + 16_000)
				harness.rerender(<LiveActivity activeTools={[]} working animate={false} />)
				expect(harness.lastFrame()).not.toContain('(')
				vi.setSystemTime(Date.now() + 1_500)
				harness.rerender(<LiveActivity activeTools={[]} working animate={false} />)
				expect(harness.lastFrame()).toContain('Working (17s)')
				vi.setSystemTime(Date.now() + 66_000)
				harness.rerender(<LiveActivity activeTools={[]} working animate={false} />)
				expect(harness.lastFrame()).toContain('Working (1m 23s)')
			} finally {
				harness.unmount()
			}
		} finally {
			vi.useRealTimers()
		}
	})

	it('leaves a blank row above the working row', () => {
		const harness = render(<LiveActivity activeTools={[]} working animate={false} />)
		try {
			const lines = (harness.lastFrame() ?? '').split('\n')
			expect(lines[0]).toBe('')
			expect(lines[1]).toContain('Working')
		} finally {
			harness.unmount()
		}
	})

	it('counts the turn’s output tokens beside its time', () => {
		const harness = render(<LiveActivity activeTools={[]} working animate={false} tokens={1_100} />)
		try {
			expect(harness.lastFrame()).toMatch(/Working \(\d+s · ↓ 1\.1k tokens\)/u)
		} finally {
			harness.unmount()
		}
		// Nothing written yet reads as nothing, not as `↓ 0 tokens`.
		const silent = render(<LiveActivity activeTools={[]} working animate={false} tokens={0} />)
		try {
			expect(silent.lastFrame()).not.toContain('tokens')
		} finally {
			silent.unmount()
		}
	})

	it('draws a running web call’s status on its own ⎿ line', () => {
		const harness = render(
			<LiveActivity
				activeTools={[
					{
						id: 'search',
						label: 'Web search("OpenClaw runtime")',
						progress: 'Searching: OpenClaw runtime',
						web: { kind: 'search', target: 'OpenClaw runtime' },
						startedAt: Date.now(),
					},
				]}
				working
				animate={false}
			/>,
		)
		try {
			const frame = harness.lastFrame() ?? ''
			expect(frame).toContain('└ Web search("OpenClaw runtime")')
			expect(frame).toContain('⎿ Searching: OpenClaw runtime')
		} finally {
			harness.unmount()
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
