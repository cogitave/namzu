import { describe, expect, it, vi } from 'vitest'

import type { HITLDecisionRequest, ToolCallSummary } from '../../../types/hitl/index.js'
import type { CheckpointId, SessionId, TurnId } from '../../../types/ids/index.js'
import {
	PLAN_MODE_REFUSAL,
	REQUIRES_APPROVAL_UNATTENDED_REFUSAL,
	STRICT_MODE_REFUSAL,
	type ToolReviewPrompt,
	createReviewHandler,
} from '../review-policy.js'

/**
 * The review policy's half of `ToolDefinition.requiresApproval`, without a
 * turn: a tool's own declaration is mode-proof the same way an escalation
 * is (see `an-escape-is-asked-about-every-time.test.ts`), not the weaker,
 * bypassable guarantee `isDestructive` gives.
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

/** A read-only, otherwise-exempt tool the author still marked `requiresApproval`. */
const approvalRead: ToolCallSummary = {
	id: 'p1',
	name: 'read_secret',
	input: { path: 'secret.txt' },
	isDestructive: false,
	requiresApproval: true,
}

/** A mutating tool the author marked `requiresApproval`, named like an accept-edits tool. */
const approvalEdit: ToolCallSummary = {
	id: 'p2',
	name: 'edit',
	input: { path: 'a.ts' },
	isDestructive: false,
	requiresApproval: true,
}

/** A mutating, non-exempt, non-accept-edits tool the author marked `requiresApproval`. */
const approvalWrite: ToolCallSummary = {
	id: 'p3',
	name: 'pay',
	input: { amountCents: 500 },
	isDestructive: false,
	requiresApproval: true,
}

const escapeCall: ToolCallSummary = {
	id: 'b1',
	name: 'bash',
	input: { command: 'echo ok', dangerously_disable_sandbox: true },
	isDestructive: false,
	escalation: { sandboxEscape: true },
}

/** Everything read-only is exempt, as the shipped exemption says of `read_secret`. */
const exemptReads = (name: string) => name === 'read_secret'

describe('a call the tool declared always needs approval', () => {
	it('is refused, never approved, in auto mode with nobody to ask', async () => {
		const handler = createReviewHandler({ mode: 'auto', exempt: exemptReads })
		expect(await handler(review(approvalWrite))).toEqual({
			action: 'reject_tools',
			feedback: REQUIRES_APPROVAL_UNATTENDED_REFUSAL,
		})
	})

	it('is asked about in auto mode when a person is there', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const handler = createReviewHandler({ mode: 'auto', prompt, exempt: exemptReads })
		expect(await handler(review(approvalWrite))).toEqual({ action: 'approve_tools' })
		expect(prompt).toHaveBeenCalledTimes(1)
	})

	it('is asked about even though the tool is read-only and otherwise exempt', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const handler = createReviewHandler({ mode: 'prompt', prompt, exempt: exemptReads })
		expect(await handler(review(approvalRead))).toEqual({ action: 'approve_tools' })
		expect(prompt).toHaveBeenCalledTimes(1)
	})

	it('is not approved by accept-edits on its own, though the tool name qualifies', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const handler = createReviewHandler({ mode: 'accept-edits', prompt, exempt: exemptReads })
		expect(await handler(review(approvalEdit))).toEqual({ action: 'approve_tools' })
		expect(prompt).toHaveBeenCalledTimes(1)
	})

	it('is refused in plan mode when the call would mutate, like any other change', async () => {
		const handler = createReviewHandler({
			mode: 'plan',
			prompt: async () => ({ kind: 'approve' }),
			exempt: exemptReads,
		})
		expect(await handler(review(approvalWrite))).toEqual({
			action: 'reject_tools',
			feedback: PLAN_MODE_REFUSAL,
		})
	})

	it('is still asked about in plan mode when the call only reads', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const handler = createReviewHandler({ mode: 'plan', prompt, exempt: exemptReads })
		expect(await handler(review(approvalRead))).toEqual({ action: 'approve_tools' })
		expect(prompt).toHaveBeenCalledTimes(1)
	})

	it('is refused under strict mode without ever asking', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const handler = createReviewHandler({ mode: 'strict', prompt, exempt: exemptReads })
		expect(await handler(review(approvalRead))).toEqual({
			action: 'reject_tools',
			feedback: STRICT_MODE_REFUSAL,
		})
		expect(prompt).not.toHaveBeenCalled()
	})

	it('is asked about again after a person answered "approve all"', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve-all' }))
		const remembered = { all: false }
		const handler = createReviewHandler({ mode: 'prompt', prompt, remembered, exempt: exemptReads })
		await handler(review(approvalWrite))
		expect(remembered.all).toBe(true)
		await handler(review({ ...approvalWrite, id: 'p4' }))
		expect(prompt).toHaveBeenCalledTimes(2)
		// …while an ordinary, exempt call after the latch is not asked about.
		await handler(review({ ...approvalRead, id: 'p5', requiresApproval: undefined }))
		expect(prompt).toHaveBeenCalledTimes(2)
	})

	it('is refused when the person declines', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'reject', feedback: 'no thanks' }))
		const handler = createReviewHandler({ mode: 'prompt', prompt, exempt: exemptReads })
		expect(await handler(review(approvalWrite))).toEqual({
			action: 'reject_tools',
			feedback: 'no thanks',
		})
	})

	it('is not waived by unattended sandbox escape approval on the same call', async () => {
		const handler = createReviewHandler({ mode: 'auto', unattendedSandboxEscape: 'allow' })
		expect(await handler(review({ ...escapeCall, requiresApproval: true }))).toEqual({
			action: 'reject_tools',
			feedback: REQUIRES_APPROVAL_UNATTENDED_REFUSAL,
		})
	})

	it('is not waived by unattended sandbox escape approval in a mixed batch', async () => {
		const handler = createReviewHandler({ mode: 'auto', unattendedSandboxEscape: 'allow' })
		expect(await handler(review(escapeCall, approvalWrite))).toEqual({
			action: 'reject_tools',
			feedback: REQUIRES_APPROVAL_UNATTENDED_REFUSAL,
		})
	})

	it('is shown with the escape in one prompt and confirms the escape by id', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const handler = createReviewHandler({
			mode: 'auto',
			prompt,
			unattendedSandboxEscape: 'allow',
		})
		expect(await handler(review({ ...escapeCall, requiresApproval: true }))).toEqual({
			action: 'approve_tools',
			confirmedEscalations: ['b1'],
		})
		expect(prompt).toHaveBeenCalledTimes(1)
		expect(prompt.mock.calls[0]?.[0].toolCalls[0]?.requiresApproval).toBe(true)
	})
})
