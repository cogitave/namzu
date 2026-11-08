import { describe, expect, it, vi } from 'vitest'

import type { HITLDecisionRequest, ToolCallSummary } from '../../../types/hitl/index.js'
import type { CheckpointId, SessionId, TurnId } from '../../../types/ids/index.js'
import { type ToolReviewPrompt, createReviewHandler } from '../review-policy.js'

/**
 * A remembered "approve all" is an answer about ordinary calls. A call a rule
 * or a hook asked a person about exists to put its own question, so the
 * latch must not approve it unseen: `mustAskPerson` says which calls those are.
 */

function review(...toolCalls: ToolCallSummary[]): HITLDecisionRequest {
	return {
		type: 'tool_review',
		sessionId: 's' as SessionId,
		turnId: 't' as TurnId,
		checkpointId: 'c' as CheckpointId,
		toolCalls,
	}
}

const ordinary: ToolCallSummary = {
	id: 'o1',
	name: 'deploy',
	input: {},
	isDestructive: false,
}

const askedByRule: ToolCallSummary = {
	id: 'r1',
	name: 'deploy',
	input: {},
	isDestructive: false,
	authorization: { decision: 'review', explicitReview: true, askRule: true },
}

const explicitlyReviewed: ToolCallSummary = {
	id: 'r2',
	name: 'deploy',
	input: {},
	isDestructive: false,
	authorization: { decision: 'review', explicitReview: true },
}

const askedByHook: ToolCallSummary = {
	id: 'h1',
	name: 'deploy',
	input: {},
	isDestructive: false,
	hookPermission: { decision: 'ask' },
}

describe('a remembered approve-all', () => {
	it('still answers an ordinary call without asking', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const handler = createReviewHandler({ mode: 'prompt', prompt, remembered: { all: true } })
		expect(await handler(review(ordinary))).toEqual({ action: 'approve_tools' })
		expect(prompt).not.toHaveBeenCalled()
	})

	it.each([
		['a rule that asked', askedByRule],
		['a rule that requested review', explicitlyReviewed],
		['a hook that asked', askedByHook],
	])('does not answer %s', async (_label, call) => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const handler = createReviewHandler({ mode: 'prompt', prompt, remembered: { all: true } })
		expect(await handler(review(call))).toEqual({ action: 'approve_tools' })
		expect(prompt).toHaveBeenCalledTimes(1)
	})

	it('asks for a batch that holds one such call among ordinary ones', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({
			kind: 'reject',
			feedback: 'no',
		}))
		const handler = createReviewHandler({ mode: 'prompt', prompt, remembered: { all: true } })
		expect(await handler(review(ordinary, askedByHook))).toMatchObject({
			action: 'reject_tools',
		})
		expect(prompt).toHaveBeenCalledTimes(1)
	})

	it('is not set by a plain yes to such a call, so the next ordinary call is still asked', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const remembered = { all: false }
		const handler = createReviewHandler({ mode: 'prompt', prompt, remembered })
		await handler(review(askedByRule))
		expect(remembered.all).toBe(false)
		await handler(review(ordinary))
		expect(prompt).toHaveBeenCalledTimes(2)
	})
})
