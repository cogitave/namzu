/**
 * A host that wants only `ask_user_question` should not have to assemble the
 * whole coordinator set — a gateway, a roster — to get it, nor invent a run
 * id before any run exists. The standalone builder takes the park handler
 * and reads the run from the call.
 */

import { describe, expect, it } from 'vitest'

import type { HITLDecisionRequest, ResumeHandler } from '../../../types/hitl/index.js'
import type { RunId } from '../../../types/ids/index.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { buildAskUserQuestionTool } from '../ask-user-question.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../index.js'

function context(runId: string): ToolContext {
	return {
		runId: runId as RunId,
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

async function ask(handler: ResumeHandler, ctx: ToolContext, runId?: RunId) {
	const tool = buildAskUserQuestionTool({ resumeHandler: handler, runId })
	return tool.execute(tool.inputSchema.parse(input), ctx)
}

describe('buildAskUserQuestionTool', () => {
	it('builds the same tool the coordinator registers, without a gateway', () => {
		const tool = buildAskUserQuestionTool({ resumeHandler: async () => ({ action: 'continue' }) })
		expect(tool.name).toBe(ASK_USER_QUESTION_TOOL_NAME)
		expect(tool.modelInputSchema).toMatchObject({ type: 'object', additionalProperties: false })
	})

	it('parks against the run that asked, read from the call context', async () => {
		const requests: HITLDecisionRequest[] = []
		const result = await ask(async (request) => {
			requests.push(request)
			return { action: 'answer_question', selectedOptionIds: ['opt_2'] }
		}, context('21ddbb1c-53ca-4cb0-980f-6657740ccd23'))
		expect(requests).toHaveLength(1)
		expect(requests[0]?.runId).toBe('21ddbb1c-53ca-4cb0-980f-6657740ccd23')
		expect(result.data).toMatchObject({ selected: [{ id: 'opt_2', label: 'Private' }] })
	})

	it('lets a host pin the run id instead', async () => {
		const requests: HITLDecisionRequest[] = []
		await ask(
			async (request) => {
				requests.push(request)
				return { action: 'answer_question', selectedOptionIds: ['opt_1'] }
			},
			context('21ddbb1c-53ca-4cb0-980f-6657740ccd23'),
			'97a5c348-1137-4d3a-af2c-1965f6b8030f' as RunId,
		)
		expect(requests[0]?.runId).toBe('97a5c348-1137-4d3a-af2c-1965f6b8030f')
	})
})
