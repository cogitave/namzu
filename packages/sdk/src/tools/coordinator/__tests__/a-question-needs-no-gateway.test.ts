/**
 * A host that wants only `ask_user_question` should not have to assemble the
 * whole coordinator set — a gateway, a roster — to get it, nor invent a turn
 * id before any turn exists. The standalone builder takes the park handler
 * and reads the session and turn from the call.
 */

import { describe, expect, it } from 'vitest'

import type { HITLDecisionRequest, ResumeHandler } from '../../../types/hitl/index.js'
import type { SessionId, TurnId } from '../../../types/ids/index.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { buildAskUserQuestionTool } from '../ask-user-question.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../index.js'

const SESSION = '5c1f3e2a-8d4b-4e6f-9a7c-1b2d3e4f5a6b' as SessionId

function context(turnId: string): ToolContext {
	return {
		sessionId: SESSION,
		turnId: turnId as TurnId,
		workingDirectory: '/tmp/test',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		toolUseId: 'toolu_q1',
	}
}

const input = {
	question: 'Which registry?',
	options: [{ label: 'Public (Recommended)' }, { label: 'Private' }],
}

async function ask(
	handler: ResumeHandler,
	ctx: ToolContext,
	pinned?: { sessionId: SessionId; turnId: TurnId },
) {
	const tool = buildAskUserQuestionTool({ resumeHandler: handler, ...pinned })
	return tool.execute(tool.inputSchema.parse(input), ctx)
}

describe('buildAskUserQuestionTool', () => {
	it('builds the same tool the coordinator registers, without a gateway', () => {
		const tool = buildAskUserQuestionTool({ resumeHandler: async () => ({ action: 'continue' }) })
		expect(tool.name).toBe(ASK_USER_QUESTION_TOOL_NAME)
		expect(tool.modelInputSchema).toMatchObject({ type: 'object', additionalProperties: false })
	})

	it('parks against the turn that asked, read from the call context', async () => {
		const requests: HITLDecisionRequest[] = []
		const result = await ask(async (request) => {
			requests.push(request)
			return { action: 'answer_question', selectedOptionIds: ['opt_2'] }
		}, context('21ddbb1c-53ca-4cb0-980f-6657740ccd23'))
		expect(requests).toHaveLength(1)
		expect(requests[0]).toMatchObject({
			sessionId: SESSION,
			turnId: '21ddbb1c-53ca-4cb0-980f-6657740ccd23',
		})
		expect(result.data).toMatchObject({ selected: [{ id: 'opt_2', label: 'Private' }] })
	})

	it('lets a host pin the session and turn instead', async () => {
		const requests: HITLDecisionRequest[] = []
		await ask(
			async (request) => {
				requests.push(request)
				return { action: 'answer_question', selectedOptionIds: ['opt_1'] }
			},
			context('21ddbb1c-53ca-4cb0-980f-6657740ccd23'),
			{
				sessionId: '0a0e4339-bdee-431d-ae33-b379bce18a26' as SessionId,
				turnId: '97a5c348-1137-4d3a-af2c-1965f6b8030f' as TurnId,
			},
		)
		expect(requests[0]).toMatchObject({
			sessionId: '0a0e4339-bdee-431d-ae33-b379bce18a26',
			turnId: '97a5c348-1137-4d3a-af2c-1965f6b8030f',
		})
	})
})
