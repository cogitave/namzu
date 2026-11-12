/**
 * The working region says the truth and holds its shape: the plan lives under
 * the working line and changes in place, a running command carries one footer
 * from its first moment, and silence is said in words.
 */

import { render } from 'ink-testing-library'
import { afterEach, expect, it, vi } from 'vitest'

import { type ActiveTool, LiveActivity } from '../LiveActivity.js'
import type { TaskListItem } from '../TaskList.js'

afterEach(() => {
	vi.useRealTimers()
})

const plan = (statuses: readonly TaskListItem['status'][]): TaskListItem[] =>
	statuses.map((status, index) => ({ id: `t${index}`, subject: `Step ${index + 1}`, status }))

const rows = (frame: string | undefined): string[] => (frame ?? '').split('\n')

it('draws the plan under the working line and updates it in place', () => {
	const view = render(
		<LiveActivity
			activeTools={[]}
			working
			animate={false}
			plan={plan(['in_progress', 'pending', 'pending'])}
			planOpen
		/>,
	)
	try {
		const first = rows(view.lastFrame())
		expect(first.filter((row) => /Step \d/u.test(row))).toHaveLength(3)
		const head = first.findIndex((row) => row.includes('Working'))
		expect(first[head + 1]).toContain('■ Step 1')
		view.rerender(
			<LiveActivity
				activeTools={[]}
				working
				animate={false}
				plan={plan(['completed', 'in_progress', 'pending'])}
				planOpen
			/>,
		)
		const next = rows(view.lastFrame())
		// Same rows, same places: the marks moved, the region did not grow.
		expect(next).toHaveLength(first.length)
		expect(next[head + 1]).toContain('✓ Step 1')
		expect(next[head + 2]).toContain('■ Step 2')
	} finally {
		view.unmount()
	}
})

it('shows only the current step when the list is collapsed, and nothing when there is no plan', () => {
	const view = render(
		<LiveActivity
			activeTools={[]}
			working
			animate={false}
			plan={plan(['completed', 'in_progress', 'pending'])}
			planOpen={false}
		/>,
	)
	try {
		const frame = view.lastFrame() ?? ''
		expect(frame).toContain('Step 2')
		expect(frame).not.toContain('Step 1')
	} finally {
		view.unmount()
	}
})

const shell = (extra: Partial<ActiveTool> = {}): ActiveTool => ({
	id: 'sh',
	label: 'Bash(make build)',
	command: 'make build',
	toolName: 'bash',
	startedAt: Date.now(),
	...extra,
})

it('gives a running command one footer from the start, so the background hint adds no row', () => {
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(new Date('2026-11-12T10:00:00Z'))
	const started = Date.now()
	const withTools = (tool: ActiveTool) => (
		<LiveActivity activeTools={[tool]} working animate={false} />
	)
	const view = render(withTools(shell({ startedAt: started, timeoutMs: 90_000 })))
	try {
		const early = rows(view.lastFrame())
		expect(early.join('\n')).toContain('Running a command')
		expect(early.join('\n')).toContain('Running… · 0s · limit 1m 30s')
		expect(early.join('\n')).not.toContain('ctrl+b')
		vi.setSystemTime(started + 6_000)
		view.rerender(withTools(shell({ startedAt: started, timeoutMs: 90_000, canBackground: true })))
		const later = rows(view.lastFrame())
		expect(later).toHaveLength(early.length)
		expect(later.join('\n')).toContain('6s · limit 1m 30s · ctrl+b to run in background')
	} finally {
		view.unmount()
	}
})

it('says how many lines a command has printed and how many are above the rows shown', () => {
	const tail = ['line 196', 'line 197', 'line 198', 'line 199', 'line 200']
	const view = render(
		<LiveActivity activeTools={[shell({ tail, outputLines: 200 })]} working animate={false} />,
	)
	try {
		const frame = view.lastFrame() ?? ''
		expect(frame).toContain('line 200')
		expect(frame).toContain('200 lines, 195 above')
		// The footer is the last row of the command, under its output.
		const at = rows(frame)
		expect(at.findIndex((row) => row.includes('195 above'))).toBeGreaterThan(
			at.findIndex((row) => row.includes('line 200')),
		)
	} finally {
		view.unmount()
	}
})

it('says a planning call in plain words, never as the call', () => {
	const view = render(
		<LiveActivity
			activeTools={[
				{
					id: 'p',
					label: 'Updating the plan',
					toolName: 'task_update',
					startedAt: Date.now(),
				},
			]}
			working
			animate={false}
		/>,
	)
	try {
		const frame = view.lastFrame() ?? ''
		expect(frame).toContain('Updating the plan')
		expect(frame).not.toMatch(/[{}]|task_update/u)
		// Said once, on the line: no row of its own to flash in and out.
		expect(frame.split('Updating the plan').length - 1).toBe(1)
	} finally {
		view.unmount()
	}
})

it('does not blame the model while a call runs, and says it waits for it when it is quiet', () => {
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(new Date('2026-11-12T10:00:00Z'))
	const view = render(<LiveActivity activeTools={[shell()]} working animate={false} />)
	try {
		vi.setSystemTime(Date.now() + 40_000)
		view.rerender(<LiveActivity activeTools={[shell()]} working animate={false} />)
		expect(view.lastFrame()).not.toContain('no reply')
		expect(view.lastFrame()).not.toContain('Waiting for the model')
	} finally {
		view.unmount()
	}
	const quiet = render(<LiveActivity activeTools={[]} working animate={false} />)
	try {
		vi.setSystemTime(Date.now() + 25_000)
		quiet.rerender(<LiveActivity activeTools={[]} working animate={false} />)
		expect(quiet.lastFrame()).toContain('Waiting for the model (25s · no reply yet)')
	} finally {
		quiet.unmount()
	}
})

it('names a retry as the line, with its own countdown row, and not as silence', () => {
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(new Date('2026-11-12T10:00:00Z'))
	const notice = {
		what: 'The model did not answer',
		retryAt: Date.now() + 5_000,
		attempt: 2,
		maxRetries: 10,
	}
	const view = render(<LiveActivity activeTools={[]} working animate={false} waitNotice={notice} />)
	try {
		vi.setSystemTime(Date.now() + 2_000)
		view.rerender(<LiveActivity activeTools={[]} working animate={false} waitNotice={notice} />)
		const frame = view.lastFrame() ?? ''
		expect(frame).toContain('Retrying')
		expect(frame).not.toContain('no reply')
	} finally {
		view.unmount()
	}
})
