/**
 * A permission mode changed while a turn runs, decided call by call.
 *
 * The interactive terminal now lets the operator press Shift+Tab mid-turn, as
 * the reference terminal does. These pin what that means for the decisions
 * themselves, against the kernel's real review handler rather than a stand-in:
 * a dialog already on screen is decided under the mode it was asked under,
 * plan mode entered mid-turn refuses the next change, leaving plan mode
 * approves nothing it already refused, and every change is recorded before
 * anything is decided under it.
 */

import {
	type ApprovalPolicy,
	type CheckpointId,
	type HITLDecisionRequest,
	PLAN_MODE_REFUSAL,
	type SessionApprovalPolicy,
	type ToolCallSummary,
	type ToolReviewAnswer,
	type TurnId,
	createReviewHandler,
	generateSessionId,
} from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { createLiveModeControl, permissionChangeReason } from '../live-mode.js'
import type { PermissionMode } from '../mode.js'

const SESSION_ID = generateSessionId()

const call = (name: string, extra: Partial<ToolCallSummary> = {}): ToolCallSummary => ({
	id: `call_${name}`,
	name,
	input: {},
	isDestructive: false,
	...extra,
})

const review = (...toolCalls: ToolCallSummary[]): HITLDecisionRequest => ({
	sessionId: SESSION_ID,
	type: 'tool_review',
	turnId: 'f8223c92-2ebb-4961-8f5c-51dffd77693e' as TurnId,
	checkpointId: '82267e66-99cd-4ee0-8a15-b8108f6fce73' as CheckpointId,
	toolCalls,
})

const READ = call('read')
const WRITE = call('write')
const BASH = call('bash', { input: { command: 'rm -rf build' }, isDestructive: true })

/** `read` is exempt from review, as the kernel's read-only rule makes it. */
const exempt = (name: string) => name === 'read'

/** A dialog the test answers when it chooses to, counting how many opened. */
function dialogs() {
	const open: Array<(answer: ToolReviewAnswer) => void> = []
	return {
		open,
		prompt: () =>
			new Promise<ToolReviewAnswer>((resolve) => {
				open.push(resolve)
			}),
	}
}

function setup(initial: PermissionMode, prompt?: () => Promise<ToolReviewAnswer>) {
	let mode: PermissionMode = initial
	const control = createLiveModeControl({
		initial,
		read: () => mode,
		handlerFor: (m) =>
			createReviewHandler({
				mode: m,
				exempt,
				remembered: { all: false },
				...(prompt ? { prompt } : {}),
			}),
	})
	return {
		control,
		set: (next: PermissionMode) => {
			mode = next
		},
	}
}

/** The kernel's box, reduced to what it records and what it holds. */
function fakeBox(initial: string, onSet?: () => Promise<void>) {
	const changes: Array<{ from: string; to: string; reason: string }> = []
	let current: ApprovalPolicy = { name: initial, handler: async () => ({ action: 'continue' }) }
	const box: SessionApprovalPolicy = {
		get current() {
			return current
		},
		async set(policy, reason) {
			await onSet?.()
			changes.push({ from: current.name, to: policy.name, reason })
			current = policy
		},
		takeUnannouncedChange: () => undefined,
	}
	return { box, changes }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('a mode changed while a turn runs', () => {
	it('decides a dialog already on screen under the mode it was asked under', async () => {
		const ui = dialogs()
		const { control, set } = setup('prompt', ui.prompt)

		const asked = control.handler(review(BASH))
		await flush()
		expect(ui.open, 'the prompt-mode dialog is on screen').toHaveLength(1)

		// The operator enters plan mode while the dialog is up, then approves
		// the command they were shown. They answered THAT question.
		set('plan')
		ui.open[0]?.({ kind: 'approve' })
		expect(await asked).toEqual({ action: 'approve_tools' })

		// The next change the turn attempts meets plan mode.
		expect(await control.handler(review(BASH))).toEqual({
			action: 'reject_tools',
			feedback: PLAN_MODE_REFUSAL,
		})
		expect(ui.open, 'plan refuses without asking').toHaveLength(1)
	})

	it('refuses every later change once plan mode is entered, and still lets reads run', async () => {
		const { control, set } = setup('auto')
		expect(await control.handler(review(WRITE))).toEqual({ action: 'approve_tools' })

		set('plan')
		expect(control.current()).toBe('plan')
		expect(await control.handler(review(WRITE))).toEqual({
			action: 'reject_tools',
			feedback: PLAN_MODE_REFUSAL,
		})
		expect(await control.handler(review(READ, BASH))).toMatchObject({ action: 'reject_tools' })
		expect(await control.handler(review(READ))).toEqual({ action: 'approve_tools' })
	})

	it('approves nothing retroactively when plan mode is left', async () => {
		const { control, set } = setup('plan')
		const refused = await control.handler(review(WRITE))
		expect(refused).toEqual({ action: 'reject_tools', feedback: PLAN_MODE_REFUSAL })

		set('auto')
		// The refused call's answer is final; only the next request sees `auto`.
		expect(refused).toEqual({ action: 'reject_tools', feedback: PLAN_MODE_REFUSAL })
		expect(await control.handler(review(WRITE))).toEqual({ action: 'approve_tools' })
	})

	it('asks again under prompt after leaving auto, rather than carrying the auto answer', async () => {
		const ui = dialogs()
		const { control, set } = setup('auto', ui.prompt)
		expect(await control.handler(review(BASH))).toEqual({ action: 'approve_tools' })
		set('prompt')
		const asked = control.handler(review(BASH))
		await flush()
		expect(ui.open).toHaveLength(1)
		ui.open[0]?.({ kind: 'reject' })
		expect(await asked).toMatchObject({ action: 'reject_tools' })
	})

	it('without a reader, keeps the mode the turn began with', async () => {
		const control = createLiveModeControl({
			initial: 'plan',
			handlerFor: (m) => createReviewHandler({ mode: m, exempt }),
		})
		expect(control.current()).toBe('plan')
		expect(await control.handler(review(WRITE))).toMatchObject({ action: 'reject_tools' })
	})
})

describe('recording a change', () => {
	it('writes it to the turn box with its reason, and only when the name changes', async () => {
		const { control, set } = setup('prompt')
		const { box, changes } = fakeBox('prompt')
		control.attach(box)
		expect(changes, 'attaching under the same mode records nothing').toEqual([])

		set('plan')
		await control.record('plan', permissionChangeReason('plan', 'now'))
		await control.record('plan', permissionChangeReason('plan', 'now'))
		expect(changes).toHaveLength(1)
		expect(changes[0]).toMatchObject({ from: 'prompt', to: 'plan' })
		expect(changes[0]?.reason).toContain('during this turn to plan mode')
		expect(box.current.handler, 'the box keeps the live handler').toBe(control.handler)
	})

	it('holds a decision until a change being recorded has landed', async () => {
		let land: () => void = () => {}
		const landed = new Promise<void>((r) => {
			land = r
		})
		const order: string[] = []
		const { control, set } = setup('auto')
		const { box } = fakeBox('auto', async () => {
			await landed
			order.push('recorded')
		})
		control.attach(box)

		set('plan')
		void control.record('plan', 'test')
		const decided = control.handler(review(WRITE)).then((d) => {
			order.push('decided')
			return d
		})
		await flush()
		expect(order, 'nothing is decided before the record lands').toEqual([])
		land()
		expect(await decided).toMatchObject({ action: 'reject_tools' })
		expect(order).toEqual(['recorded', 'decided'])
	})

	it('holds a request that was already waiting when the change began', async () => {
		let land: () => void = () => {}
		const landed = new Promise<void>((r) => {
			land = r
		})
		const { control, set } = setup('auto')
		const { box, changes } = fakeBox('auto', () => landed)
		control.attach(box)

		// The request is in flight first; the change starts in the same tick.
		let settled = false
		const decided = control.handler(review(WRITE)).finally(() => {
			settled = true
		})
		set('plan')
		void control.record('plan', 'test')
		await flush()
		expect(changes, 'still being written').toEqual([])
		expect(settled, 'no decision under a change the log does not hold yet').toBe(false)
		land()
		expect(await decided, 'decided under the change once it is durable').toMatchObject({
			action: 'reject_tools',
		})
		expect(changes).toHaveLength(1)
	})

	it('records a change made between turns on the next turn it starts', async () => {
		const control = createLiveModeControl({
			initial: 'accept-edits',
			recorded: 'prompt',
			read: () => 'accept-edits',
			handlerFor: (m) => createReviewHandler({ mode: m, exempt }),
		})
		expect(control.initialName, 'the turn starts under the name the log last recorded').toBe(
			'prompt',
		)
		const { box, changes } = fakeBox(control.initialName)
		control.attach(box)
		await control.record('accept-edits', 'noop, already recorded by attach')
		expect(changes).toHaveLength(1)
		expect(changes[0]).toMatchObject({ from: 'prompt', to: 'accept-edits' })
		expect(changes[0]?.reason).toContain('since the previous turn')
	})

	it('swallows a failure to record, so review is never wedged by the log', async () => {
		const { control, set } = setup('auto')
		const box: SessionApprovalPolicy = {
			current: { name: 'auto', handler: control.handler },
			set: async () => {
				throw new Error('disk full')
			},
			takeUnannouncedChange: () => undefined,
		}
		control.attach(box)
		set('plan')
		await expect(control.record('plan', 'x')).resolves.toBeUndefined()
		expect(await control.handler(review(WRITE))).toMatchObject({ action: 'reject_tools' })
	})
})
