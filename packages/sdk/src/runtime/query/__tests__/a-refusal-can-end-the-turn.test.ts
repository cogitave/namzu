import { describe, expect, it, vi } from 'vitest'

import type { HITLDecisionRequest, ToolCallSummary } from '../../../types/hitl/index.js'
import type { CheckpointId, SessionId, TurnId } from '../../../types/ids/index.js'
import { type ToolReviewPrompt, createReviewHandler } from '../review-policy.js'

/**
 * What the shipped policy tells a prompt about a per-call question, and how a
 * plain No (as against a No with a reason) reaches the turn.
 */

const call: ToolCallSummary = {
	id: 'b1',
	name: 'bash',
	input: { command: 'make' },
	isDestructive: false,
}

function review(extra: { perCall?: true } = {}): HITLDecisionRequest {
	return {
		type: 'tool_review',
		sessionId: 's' as SessionId,
		turnId: 't' as TurnId,
		checkpointId: 'c' as CheckpointId,
		toolCalls: [call],
		...extra,
	}
}

describe('a refusal that ends the turn', () => {
	it('is carried to the turn by a plain No and not by a No with a reason', async () => {
		const answers: Awaited<ReturnType<ToolReviewPrompt>>[] = [
			{ kind: 'reject', declined: {}, endTurn: true },
			{
				kind: 'reject',
				feedback: 'Use make test.',
				declined: { note: 'Use make test.' },
			},
		]
		const prompt: ToolReviewPrompt = vi.fn(async () => answers.shift() as never)
		const handler = createReviewHandler({
			mode: 'prompt',
			prompt,
			exempt: () => false,
		})

		expect(await handler(review())).toMatchObject({
			action: 'reject_tools',
			endTurn: true,
		})
		const withReason = await handler(review())
		expect(withReason).toMatchObject({
			action: 'reject_tools',
			feedback: 'Use make test.',
		})
		expect('endTurn' in withReason).toBe(false)
	})
})

describe('the question put to a prompt', () => {
	it('names a per-call question and hands over the signal that closes it', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const handler = createReviewHandler({
			mode: 'prompt',
			prompt,
			exempt: () => false,
		})
		const closed = new AbortController()

		await handler(review({ perCall: true }), {
			transcript: () => [],
			signal: closed.signal,
		})

		expect(prompt).toHaveBeenCalledWith(
			expect.objectContaining({ perCall: true, signal: closed.signal }),
		)
	})

	it('asks about a whole batch exactly as before: no per-call field, no signal', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const handler = createReviewHandler({
			mode: 'prompt',
			prompt,
			exempt: () => false,
		})

		await handler(review(), {
			transcript: () => [],
			signal: new AbortController().signal,
		})

		const asked = prompt.mock.calls[0]?.[0] as unknown as Record<string, unknown>
		expect('perCall' in asked).toBe(false)
		expect('signal' in asked).toBe(false)
	})
})
