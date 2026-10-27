import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PlanApprovalAnswer } from '../../plan/approval.js'
import { PlanApprovalOverlay, planPageRows } from '../PlanApprovalOverlay.js'
import { APPROVAL_SETTLE_MS } from '../consent-timing.js'

/**
 * The plan approval box: what it shows, which key answers what, and that a
 * key already in flight cannot approve a plan nobody has read.
 */

const PLAN = '# Plan: greet\n\n## Approach\n1. Add a hello line.\n\n## Verify\n- cat README.md'
const request = (bypassAvailable = false) => ({
	plan: PLAN,
	planPath: '/h/.namzu/projects/p/s/plans/plan.md',
	bypassAvailable,
})

const KEY = {
	enter: '\r',
	esc: '\x1b',
	down: '\x1b[B',
	up: '\x1b[A',
	shiftTab: '\x1b[Z',
	ctrlC: '\x03',
}

let clock = 0
const now = () => clock

function mount(opts: { bypass?: boolean; rows?: number } = {}) {
	clock = 1_000
	const answers: PlanApprovalAnswer[] = []
	const interrupts: number[] = []
	const harness = render(
		<PlanApprovalOverlay
			request={request(opts.bypass)}
			columns={100}
			rows={opts.rows ?? 40}
			now={now}
			onAnswer={(answer) => answers.push(answer)}
			onInterrupt={() => interrupts.push(1)}
		/>,
	)
	return { ...harness, answers, interrupts }
}
const settle = () => {
	clock += APPROVAL_SETTLE_MS + 1
}
// Ink reads stdin on a later tick; flush it before looking at what a key did.
const tick = () => new Promise((resolve) => setTimeout(resolve, 20))
async function press(h: ReturnType<typeof mount>, ...keys: string[]) {
	for (const key of keys) {
		h.stdin.write(key)
		await tick()
	}
}

afterEach(() => vi.restoreAllMocks())

describe('the plan approval box', () => {
	it('shows the plan and the three rows in order, never the folder the plan is kept in', () => {
		const h = mount()
		const frame = h.lastFrame() ?? ''
		expect(frame).toContain('Plan ready for review')
		expect(frame).not.toContain('plans/plan.md')
		expect(frame).not.toContain('.namzu')
		expect(frame).toContain('Add a hello line.')
		expect(frame).toMatch(
			/1\. Yes, and auto-approve edits[\s\S]*2\. Yes, and ask before each edit[\s\S]*3\. No, keep planning/,
		)
		expect(frame).toContain('❯ 1.')
		h.unmount()
	})

	it('offers running without asking in place of the first row when the session may', () => {
		const frame = mount({ bypass: true }).lastFrame() ?? ''
		expect(frame).toContain('1. Yes, and run every tool without asking')
		expect(frame).not.toContain('auto-approve edits')
	})

	it('Enter on the first row approves with accept-edits, the second with prompt', async () => {
		const first = mount()
		settle()
		await press(first, KEY.enter)
		expect(first.answers).toEqual([{ kind: 'approve', mode: 'accept-edits' }])
		const second = mount()
		settle()
		await press(second, KEY.down, KEY.enter)
		expect(second.answers).toEqual([{ kind: 'approve', mode: 'prompt' }])
	})

	it('picks by digit, and a session that may bypass approves with bypass', async () => {
		const h = mount({ bypass: true })
		settle()
		await press(h, '1')
		expect(h.answers).toEqual([{ kind: 'approve', mode: 'bypass' }])
		const two = mount()
		settle()
		await press(two, '2')
		expect(two.answers).toEqual([{ kind: 'approve', mode: 'prompt' }])
	})

	it('ignores an approving key that arrives before the box has settled, but never a refusal', async () => {
		const h = mount()
		await press(h, KEY.enter, '1')
		expect(h.answers).toEqual([])
		await press(h, KEY.esc)
		expect(h.answers).toEqual([{ kind: 'keep-planning' }])
	})

	it('sends typed words back with "keep planning", and ignores Enter on an empty text row', async () => {
		const h = mount()
		settle()
		await press(h, '3')
		expect(h.lastFrame()).toContain('Tell namzu what to change')
		await press(h, KEY.enter)
		expect(h.answers).toEqual([])
		await press(h, ...'cover the migration'.split(''))
		expect(h.lastFrame()).toContain('3. No, keep planning: cover the migration')
		await press(h, KEY.enter)
		expect(h.answers).toEqual([{ kind: 'keep-planning', feedback: 'cover the migration' }])
	})

	it('starts the feedback when a letter is typed anywhere, and digits are text on that row', async () => {
		const h = mount()
		settle()
		await press(h, 'a', '2', 'b')
		expect(h.lastFrame()).toContain('keep planning: a2b')
		expect(h.answers).toEqual([])
	})

	it('Shift+Tab approves the first row with whatever was typed', async () => {
		const h = mount()
		settle()
		await press(h, ...'ship it'.split(''), KEY.shiftTab)
		expect(h.answers).toEqual([{ kind: 'approve', mode: 'accept-edits', feedback: 'ship it' }])
	})

	it('Esc keeps planning without words, and Ctrl+C stops the reply instead of answering', async () => {
		const h = mount()
		await press(h, KEY.ctrlC)
		expect(h.interrupts).toEqual([1])
		expect(h.answers).toEqual([])
		await press(h, KEY.esc)
		expect(h.answers).toEqual([{ kind: 'keep-planning' }])
	})

	it('pages a plan longer than the screen', async () => {
		const long = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join('\n')
		clock = 1_000
		const h = render(
			<PlanApprovalOverlay
				request={{ ...request(), plan: long }}
				columns={100}
				rows={24}
				now={now}
				onAnswer={() => {}}
			/>,
		)
		expect(h.lastFrame()).toContain('line 1')
		expect(h.lastFrame()).not.toContain('line 80')
		expect(h.lastFrame()).toContain(`rows 1-${planPageRows(24)}/80`)
		h.stdin.write('\x1b[6~')
		await tick()
		expect(h.lastFrame()).not.toContain('line 1\n')
		expect(h.lastFrame()).toContain(`rows ${planPageRows(24) + 1}-`)
	})
})
