import { describe, expect, it, vi } from 'vitest'

import type { HITLDecisionRequest, ToolCallSummary } from '../../../types/hitl/index.js'
import type { CheckpointId, SessionId, TurnId } from '../../../types/ids/index.js'
import {
	PLAN_MODE_REFUSAL,
	type ReviewMode,
	SCREEN_CONSENT_DECLINED_FEEDBACK,
	SCREEN_CONSENT_UNATTENDED_REFUSAL,
	STRICT_MODE_REFUSAL,
	type ScreenConsentRecord,
	type ToolReviewPrompt,
	createReviewHandler,
} from '../review-policy.js'

/**
 * The first look at the screen in a session is the operator's to allow:
 * asked once, with the batch, in the modes where a person decides; after a
 * yes, later looks in the same session run as the reads they are; a new
 * session asks again.
 */

function review(session: string, ...toolCalls: ToolCallSummary[]): HITLDecisionRequest {
	return {
		type: 'tool_review',
		sessionId: session as SessionId,
		turnId: 't' as TurnId,
		checkpointId: 'c' as CheckpointId,
		toolCalls,
	}
}

const screenshot: ToolCallSummary = {
	id: 's1',
	name: 'computer_use',
	input: { type: 'screenshot' },
	isDestructive: false,
}
const click: ToolCallSummary = {
	id: 'c1',
	name: 'computer_use',
	input: { type: 'mouse_click', at: { x: 1, y: 1 }, button: 'left' },
	isDestructive: true,
}
const cursor: ToolCallSummary = {
	id: 'p1',
	name: 'computer_use',
	input: { type: 'cursor_position' },
	isDestructive: false,
}
const read: ToolCallSummary = { id: 'r1', name: 'read', input: { path: 'a' }, isDestructive: false }

/** The tool's own declarations, as `computer_use` makes them. */
const readOnly = (name: string, input: unknown) =>
	name === 'read' ||
	(name === 'computer_use' &&
		['screenshot', 'cursor_position'].includes((input as { type: string }).type))
const captures = (name: string, input: unknown) =>
	name === 'computer_use' && (input as { type: string }).type !== 'cursor_position'

function policy(mode: ReviewMode, answer: 'approve' | 'reject' | null) {
	const prompt =
		answer === null
			? undefined
			: vi.fn<ToolReviewPrompt>(async () =>
					answer === 'approve' ? { kind: 'approve' } : { kind: 'reject' },
				)
	const consent: ScreenConsentRecord = { sessions: new Set() }
	const handler = createReviewHandler({
		mode,
		...(prompt ? { prompt } : {}),
		exempt: readOnly,
		screenConsent: consent,
		capturesScreen: captures,
	})
	return { handler, prompt, consent }
}

describe('sharing the screen', () => {
	it('asks once in prompt mode, with the batch and the question, then lets later looks run', async () => {
		const { handler, prompt, consent } = policy('prompt', 'approve')
		expect(await handler(review('a', screenshot))).toEqual({ action: 'approve_tools' })
		expect(prompt).toHaveBeenCalledTimes(1)
		expect(prompt?.mock.calls[0]?.[0]).toEqual({
			sessionId: 'a',
			turnId: 't',
			toolCalls: [screenshot],
			screenConsent: true,
		})
		expect([...consent.sessions]).toEqual(['a'])
		expect(await handler(review('a', { ...screenshot, id: 's2' }))).toEqual({
			action: 'approve_tools',
		})
		expect(prompt).toHaveBeenCalledTimes(1)
	})

	it('keeps reviewing clicks after the screen was shared', async () => {
		const { handler, prompt } = policy('prompt', 'approve')
		await handler(review('a', screenshot))
		await handler(review('a', click))
		expect(prompt).toHaveBeenCalledTimes(2)
		expect(prompt?.mock.calls[1]?.[0]).not.toHaveProperty('screenConsent')
	})

	it('asks one question, not two, for a first batch that also needs review', async () => {
		const { handler, prompt } = policy('prompt', 'approve')
		expect(await handler(review('a', screenshot, click))).toEqual({ action: 'approve_tools' })
		expect(prompt).toHaveBeenCalledTimes(1)
		expect(prompt?.mock.calls[0]?.[0].screenConsent).toBe(true)
	})

	it('asks again in a new session', async () => {
		const { handler, prompt } = policy('prompt', 'approve')
		await handler(review('a', screenshot))
		await handler(review('b', screenshot))
		expect(prompt).toHaveBeenCalledTimes(2)
		expect(prompt?.mock.calls[1]?.[0].screenConsent).toBe(true)
	})

	it('refuses the batch and remembers nothing when the operator says no', async () => {
		const { handler, prompt, consent } = policy('prompt', 'reject')
		expect(await handler(review('a', screenshot))).toEqual({
			action: 'reject_tools',
			feedback: SCREEN_CONSENT_DECLINED_FEEDBACK,
		})
		expect(consent.sessions.size).toBe(0)
		await handler(review('a', screenshot))
		expect(prompt).toHaveBeenCalledTimes(2)
	})

	it('asks in accept-edits too', async () => {
		const { handler, prompt } = policy('accept-edits', 'approve')
		expect(await handler(review('a', screenshot))).toEqual({ action: 'approve_tools' })
		expect(prompt).toHaveBeenCalledTimes(1)
	})

	it('in plan mode lets the look run only after the one approval, and still refuses a click', async () => {
		const { handler, prompt } = policy('plan', 'approve')
		expect(await handler(review('a', screenshot))).toEqual({ action: 'approve_tools' })
		expect(prompt).toHaveBeenCalledTimes(1)
		expect(await handler(review('a', click))).toEqual({
			action: 'reject_tools',
			feedback: PLAN_MODE_REFUSAL,
		})
		expect(prompt).toHaveBeenCalledTimes(1)
	})

	it('in plan mode with nobody to ask, refuses the look', async () => {
		const { handler } = policy('plan', null)
		expect(await handler(review('a', screenshot))).toEqual({
			action: 'reject_tools',
			feedback: SCREEN_CONSENT_UNATTENDED_REFUSAL,
		})
	})

	it('in strict mode refuses the look unless a rule allowed it', async () => {
		const { handler, prompt } = policy('strict', 'approve')
		expect(await handler(review('a', screenshot))).toEqual({
			action: 'reject_tools',
			feedback: STRICT_MODE_REFUSAL,
		})
		expect(prompt).not.toHaveBeenCalled()
		const allowed = { ...screenshot, authorization: { decision: 'allow' as const } }
		expect(await handler(review('a', allowed))).toEqual({ action: 'approve_tools' })
	})

	it('never asks in auto mode', async () => {
		const { handler, prompt, consent } = policy('auto', 'approve')
		expect(await handler(review('a', screenshot))).toEqual({ action: 'approve_tools' })
		expect(prompt).not.toHaveBeenCalled()
		expect(consent.sessions.size).toBe(0)
	})

	it('does not ask about a call that shows nothing of the screen', async () => {
		const { handler, prompt } = policy('prompt', 'approve')
		expect(await handler(review('a', cursor, read))).toEqual({ action: 'approve_tools' })
		expect(prompt).not.toHaveBeenCalled()
	})

	it('reads the tool’s own declaration from the registry by default', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const registry = {
			get: (name: string) =>
				name === 'computer_use'
					? ({
							name,
							isReadOnly: () => true,
							capturesScreen: (input: unknown) => (input as { type: string }).type === 'screenshot',
						} as never)
					: undefined,
			sourceOf: () => ({ id: 'test', kind: 'host_tool' as const }),
		}
		const handler = createReviewHandler({
			mode: 'prompt',
			prompt,
			registry,
			screenConsent: { sessions: new Set() },
		})
		await handler(review('a', screenshot))
		expect(prompt).toHaveBeenCalledTimes(1)
		expect(prompt.mock.calls[0]?.[0].screenConsent).toBe(true)
	})

	it('without a consent record, treats the screen like any other read', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const handler = createReviewHandler({ mode: 'prompt', prompt, exempt: readOnly })
		expect(await handler(review('a', screenshot))).toEqual({ action: 'approve_tools' })
		expect(prompt).not.toHaveBeenCalled()
	})
})
