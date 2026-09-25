import { describe, expect, it, vi } from 'vitest'

import type { HITLDecisionRequest, ToolCallSummary } from '../../../types/hitl/index.js'
import type { CheckpointId, SessionId, TurnId } from '../../../types/ids/index.js'
import {
	OUTSIDE_ROOTS_UNATTENDED_REFUSAL,
	type ToolReviewPrompt,
	UNKNOWN_PROGRAM_UNATTENDED_REFUSAL,
	createReviewHandler,
} from '../review-policy.js'

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
	input: { command: 'echo ok', dangerously_disable_sandbox: true },
	isDestructive: false,
	escalation: { sandboxEscape: true },
}

const unknownCall: ToolCallSummary = {
	...escapeCall,
	input: { command: '$(echo echo) ok', dangerously_disable_sandbox: true },
	escalation: { sandboxEscape: true, unknownProgram: 'decided at runtime: $(echo echo)' },
}

describe('an unreadable program alongside a sandbox escape', () => {
	it('is refused on the same call despite unattended escape approval', async () => {
		const handler = createReviewHandler({ mode: 'auto', unattendedSandboxEscape: 'allow' })
		expect(await handler(review(unknownCall))).toEqual({
			action: 'reject_tools',
			feedback: UNKNOWN_PROGRAM_UNATTENDED_REFUSAL,
		})
	})

	it('is refused in a mixed batch despite unattended escape approval', async () => {
		const handler = createReviewHandler({ mode: 'auto', unattendedSandboxEscape: 'allow' })
		const otherCall: ToolCallSummary = {
			...unknownCall,
			id: 'b2',
			escalation: { unknownProgram: 'decided at runtime: $(echo echo)' },
		}
		expect(await handler(review(escapeCall, otherCall))).toEqual({
			action: 'reject_tools',
			feedback: UNKNOWN_PROGRAM_UNATTENDED_REFUSAL,
		})
	})

	it('also refuses a separate outside-roots read in the same batch', async () => {
		const handler = createReviewHandler({ mode: 'auto', unattendedSandboxEscape: 'allow' })
		const outsideRead: ToolCallSummary = {
			id: 'r1',
			name: 'read',
			input: { path: '/elsewhere' },
			isDestructive: false,
			escalation: { outsidePaths: ['/elsewhere'] },
		}
		expect(await handler(review(escapeCall, outsideRead))).toEqual({
			action: 'reject_tools',
			feedback: OUTSIDE_ROOTS_UNATTENDED_REFUSAL,
		})
	})

	it('shows both reasons to a person once and confirms an approved escape by id', async () => {
		const prompt = vi.fn<ToolReviewPrompt>(async () => ({ kind: 'approve' }))
		const handler = createReviewHandler({
			mode: 'auto',
			prompt,
			unattendedSandboxEscape: 'allow',
		})
		expect(await handler(review(unknownCall))).toEqual({
			action: 'approve_tools',
			confirmedEscalations: ['b1'],
		})
		expect(prompt).toHaveBeenCalledTimes(1)
		expect(prompt.mock.calls[0]?.[0].toolCalls[0]?.escalation).toEqual(unknownCall.escalation)
	})
})
