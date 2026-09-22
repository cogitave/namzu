import { describe, expect, it, vi } from 'vitest'

import type { HITLDecisionRequest, ToolCallSummary } from '../../../types/hitl/index.js'
import type { CheckpointId, SessionId, TurnId } from '../../../types/ids/index.js'
import {
	PLAN_MODE_REFUSAL,
	SANDBOX_ESCAPE_UNATTENDED_REFUSAL,
	type ToolReviewPrompt,
	createReviewHandler,
} from '../review-policy.js'

/**
 * The review policy's half of the escalation rules, without a turn: which
 * answers a mode may give by itself, and which only a person may.
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

const escapeCall: ToolCallSummary = {
	id: 'b1',
	name: 'bash',
	input: { command: 'curl example.com', dangerously_disable_sandbox: true },
	isDestructive: false,
	escalation: { sandboxEscape: true },
}

const outsideRead: ToolCallSummary = {
	id: 'r1',
	name: 'read',
	input: { path: '/mnt/c/Users/me/notes.txt' },
	isDestructive: false,
	escalation: { outsidePaths: ['/mnt/c/Users/me/notes.txt'] },
}

const outsideWrite: ToolCallSummary = {
	id: 'w1',
	name: 'write',
	input: { path: '/etc/hosts', content: 'x' },
	isDestructive: false,
	escalation: { outsidePaths: ['/etc/hosts'] },
}

/** Everything read-only is exempt, as the shipped exemption says of `read`. */
const exemptReads = (name: string) => name === 'read'

describe('a sandbox escape', () => {
	it('is refused, never approved, in auto mode with nobody to ask', async () => {
		const handler = createReviewHandler({ mode: 'auto', exempt: exemptReads })
		expect(await handler(review(escapeCall))).toEqual({
			action: 'reject_tools',
			feedback: SANDBOX_ESCAPE_UNATTENDED_REFUSAL,
		})
	})

	it('is asked about in auto mode when a person is there, and confirmed by id', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const handler = createReviewHandler({ mode: 'auto', prompt, exempt: exemptReads })
		expect(await handler(review(escapeCall))).toEqual({
			action: 'approve_tools',
			confirmedEscalations: ['b1'],
		})
		expect(prompt).toHaveBeenCalledTimes(1)
	})

	it('is asked about again after a person answered "approve all"', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve-all' }))
		const remembered = { all: false }
		const handler = createReviewHandler({ mode: 'prompt', prompt, remembered })
		await handler(review(escapeCall))
		expect(remembered.all).toBe(true)
		await handler(review({ ...escapeCall, id: 'b2' }))
		expect(prompt).toHaveBeenCalledTimes(2)
		// …while an ordinary call after the latch is not.
		await handler(review({ ...escapeCall, id: 'b3', escalation: undefined }))
		expect(prompt).toHaveBeenCalledTimes(2)
	})

	it('is refused in plan mode like any other change', async () => {
		const handler = createReviewHandler({ mode: 'plan', prompt: async () => ({ kind: 'approve' }) })
		expect(await handler(review(escapeCall))).toEqual({
			action: 'reject_tools',
			feedback: PLAN_MODE_REFUSAL,
		})
	})

	it('runs unattended only where the operator allowed it', async () => {
		const handler = createReviewHandler({ mode: 'auto', unattendedSandboxEscape: 'allow' })
		expect(await handler(review(escapeCall))).toEqual({
			action: 'approve_tools',
			confirmedEscalations: ['b1'],
		})
	})
})

describe('a path outside the working directory', () => {
	it('is asked about even though the tool only reads', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const handler = createReviewHandler({ mode: 'prompt', prompt, exempt: exemptReads })
		expect(await handler(review(outsideRead))).toEqual({ action: 'approve_tools' })
		expect(prompt).toHaveBeenCalledTimes(1)
	})

	it('is not approved by accept-edits on its own', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'reject', feedback: 'no' }))
		const handler = createReviewHandler({ mode: 'accept-edits', prompt, exempt: exemptReads })
		expect(await handler(review(outsideWrite))).toMatchObject({ action: 'reject_tools' })
		expect(prompt).toHaveBeenCalledTimes(1)
	})

	it('follows the mode where the mode approves, since it needs no confirmation by id', async () => {
		const handler = createReviewHandler({ mode: 'auto', exempt: exemptReads })
		expect(await handler(review(outsideRead))).toEqual({ action: 'approve_tools' })
	})
})
