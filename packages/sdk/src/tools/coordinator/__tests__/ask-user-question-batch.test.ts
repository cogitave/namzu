import { describe, expect, it } from 'vitest'

import { PendingAnswers } from '../../../runtime/query/question-park.js'
import type {
	HITLDecisionRequest,
	HITLResumeDecision,
	ResumeHandler,
	UserQuestionData,
} from '../../../types/hitl/index.js'
import type { SessionId, TurnId } from '../../../types/ids/index.js'
import type { ToolContext, ToolDefinition } from '../../../types/tool/index.js'
import { buildAskUserQuestionTool } from '../ask-user-question.js'

const TOOL_USE_ID = 'toolu_batch_1'

function context(): ToolContext {
	return {
		sessionId: '4db4b128-e808-43d9-ac50-b6e79a72c452' as SessionId,
		turnId: '0199a3c2-7c1e-7b4a-9d2f-5e6a7b8c9d0e' as TurnId,
		workingDirectory: '/tmp/test',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		toolUseId: TOOL_USE_ID,
	}
}

const q = (question: string, header?: string, extra: Record<string, unknown> = {}) => ({
	question,
	...(header !== undefined ? { header } : {}),
	options: [{ label: 'One' }, { label: 'Two', description: 'second' }, { label: 'Three' }],
	...extra,
})

const THREE = {
	questions: [
		q('Which audience?', 'Audience'),
		q('Which environments?', 'Environment', { multiSelect: true }),
		q('What is it for?', 'Purpose'),
	],
}

function setup(decision: HITLResumeDecision | ((r: HITLDecisionRequest) => HITLResumeDecision)) {
	const requests: HITLDecisionRequest[] = []
	const handler: ResumeHandler = async (request) => {
		requests.push(request)
		return typeof decision === 'function' ? decision(request) : decision
	}
	const pendingAnswers = new PendingAnswers()
	const tool: ToolDefinition = buildAskUserQuestionTool({
		resumeHandler: handler,
		pendingAnswers,
	})
	const run = async (input: unknown) =>
		tool.execute(tool.inputSchema.parse(input) as never, context())
	return { tool, requests, run, pendingAnswers }
}

const parked = (requests: HITLDecisionRequest[]): UserQuestionData => {
	const request = requests[0]
	if (request?.type !== 'user_question') throw new Error('no question was parked')
	return request.question
}

describe('ask_user_question input: a batch of questions', () => {
	const { tool } = setup({ action: 'continue' })

	it('accepts one, two and four questions', () => {
		for (const n of [1, 2, 4]) {
			const questions = Array.from({ length: n }, (_, i) => q(`Question ${i}?`, `H${i}`))
			expect(tool.inputSchema.safeParse({ questions }).success, `${n}`).toBe(true)
		}
	})

	it('rejects none and five', () => {
		expect(tool.inputSchema.safeParse({ questions: [] }).success).toBe(false)
		const five = Array.from({ length: 5 }, (_, i) => q(`Question ${i}?`, `H${i}`))
		expect(tool.inputSchema.safeParse({ questions: five }).success).toBe(false)
	})

	it('rejects duplicate headers and duplicate question texts', () => {
		expect(
			tool.inputSchema.safeParse({
				questions: [q('A?', 'Same'), q('B?', 'same')],
			}).success,
		).toBe(false)
		expect(tool.inputSchema.safeParse({ questions: [q('A?', 'X'), q('a?', 'Y')] }).success).toBe(
			false,
		)
		// Questions without headers do not collide on a missing header.
		expect(tool.inputSchema.safeParse({ questions: [q('A?'), q('B?')] }).success).toBe(true)
	})

	it('still accepts the older single-question input as a one-element batch', () => {
		const parsed = tool.inputSchema.parse(q('Which audience?', 'Audience')) as {
			questions: unknown[]
		}
		expect(parsed.questions).toHaveLength(1)
		expect(tool.inputSchema.safeParse({ ...q('A?'), questions: [q('B?')] }).success).toBe(false)
	})

	it('keeps every question as strict as a lone question', () => {
		const bad = {
			questions: [q('A?'), { question: 'B?', options: [{ label: 'only' }] }],
		}
		expect(tool.inputSchema.safeParse(bad).success).toBe(false)
		expect(
			tool.inputSchema.safeParse({
				questions: [{ ...q('A?'), multiSelct: true }],
			}).success,
		).toBe(false)
	})

	it('offers the model the questions array and nothing else', () => {
		expect(tool.modelInputSchema).toMatchObject({
			required: ['questions'],
			additionalProperties: false,
		})
		expect(tool.description).not.toContain('Ask ONE question per call')
	})
})

describe('ask_user_question parks the whole batch', () => {
	it('carries every question with a stable id, mirroring the first at the top level', async () => {
		const { requests, run } = setup({ action: 'continue' })
		await run(THREE)
		const question = parked(requests)
		expect(question.questionId).toBe(TOOL_USE_ID)
		expect(question.questions?.map((item) => item.id)).toEqual([
			`${TOOL_USE_ID}#0`,
			`${TOOL_USE_ID}#1`,
			`${TOOL_USE_ID}#2`,
		])
		expect(question.question).toBe('Which audience?')
		expect(question.header).toBe('Audience')
		expect(question.options.map((o) => o.id)).toEqual(['opt_1', 'opt_2', 'opt_3'])
		expect(question.questions?.[1]?.multiSelect).toBe(true)
	})

	it('leaves a lone question without a questions field', async () => {
		const { requests, run } = setup({ action: 'continue' })
		await run(q('Which audience?', 'Audience'))
		expect(parked(requests).questions).toBeUndefined()
	})

	it('carries an option preview through to the host', async () => {
		const { requests, run } = setup({ action: 'continue' })
		await run({
			questions: [
				{
					question: 'Which layout?',
					options: [{ label: 'Grid', preview: '+--+--+' }, { label: 'List' }],
				},
			],
		})
		expect(parked(requests).options[0]?.preview).toBe('+--+--+')
		expect(parked(requests).options[1]).not.toHaveProperty('preview')
	})
})

describe('ask_user_question answers', () => {
	it('reports one line per question, with own words and notes', async () => {
		const { run } = setup({
			action: 'answer_question',
			selectedOptionIds: [],
			questionId: TOOL_USE_ID,
			answers: [
				{ questionId: `${TOOL_USE_ID}#0`, selectedOptionIds: ['opt_1'] },
				{
					questionId: `${TOOL_USE_ID}#1`,
					selectedOptionIds: ['opt_1', 'opt_3'],
				},
				{
					questionId: `${TOOL_USE_ID}#2`,
					selectedOptionIds: [],
					freeText: ' monthly cost report ',
				},
			],
		})
		const result = await run(THREE)
		expect(result.success).toBe(true)
		expect(result.output).toBe(
			[
				'The user answered 3 of 3 questions:',
				'Audience: "One"',
				'Environment: "One", "Three"',
				'Purpose (own words): "monthly cost report"',
			].join('\n'),
		)
		expect(result.data).toMatchObject({
			answered: true,
			answers: [
				{
					questionId: `${TOOL_USE_ID}#0`,
					header: 'Audience',
					selected: [{ id: 'opt_1', label: 'One' }],
					answered: true,
				},
				{
					questionId: `${TOOL_USE_ID}#1`,
					selected: [{ id: 'opt_1' }, { id: 'opt_3' }],
					answered: true,
				},
				{
					questionId: `${TOOL_USE_ID}#2`,
					selected: [],
					freeText: 'monthly cost report',
					answered: true,
				},
			],
		})
	})

	it('marks a question with no entry as not answered, without assuming a choice', async () => {
		const { run } = setup({
			action: 'answer_question',
			selectedOptionIds: [],
			answers: [{ questionId: `${TOOL_USE_ID}#1`, selectedOptionIds: ['opt_2'] }],
		})
		const result = await run(THREE)
		expect(result.output).toContain('The user answered 1 of 3 questions:')
		expect(result.output).toContain('Audience: not answered, assume nothing')
		expect(result.output).toContain('Environment: "Two"')
		const answers = (result.data as { answers: { answered: boolean }[] }).answers
		expect(answers.map((a) => a.answered)).toEqual([false, true, false])
	})

	it('drops an entry that names no question of this call, and a repeated entry', async () => {
		const { run } = setup({
			action: 'answer_question',
			selectedOptionIds: [],
			answers: [
				{ questionId: 'toolu_other#0', selectedOptionIds: ['opt_1'] },
				{ questionId: `${TOOL_USE_ID}#0`, selectedOptionIds: ['opt_2'] },
				{ questionId: `${TOOL_USE_ID}#0`, selectedOptionIds: ['opt_3'] },
			],
		})
		const result = await run(THREE)
		expect(result.output).toContain('Audience: "Two"')
		expect(result.output).toContain('The user answered 1 of 3 questions:')
	})

	it('keeps one choice for a question that is not multi-select', async () => {
		const { run } = setup({
			action: 'answer_question',
			selectedOptionIds: [],
			answers: [
				{
					questionId: `${TOOL_USE_ID}#0`,
					selectedOptionIds: ['opt_1', 'opt_2'],
				},
			],
		})
		const result = await run(THREE)
		expect(result.output).toContain('Audience: "One"\n')
	})

	it('answers only the first question for a host that knows one question', async () => {
		const { run } = setup({
			action: 'answer_question',
			selectedOptionIds: ['opt_3'],
			questionId: TOOL_USE_ID,
		})
		const result = await run(THREE)
		expect(result.output).toContain('The user answered 1 of 3 questions:')
		expect(result.output).toContain('Audience: "Three"')
		expect(result.output).toContain('Environment: not answered')
	})

	it('treats a batch with nothing answered as the no-answer sentinel', async () => {
		const { run } = setup({
			action: 'answer_question',
			selectedOptionIds: [],
			answers: [{ questionId: `${TOOL_USE_ID}#0`, selectedOptionIds: [] }],
		})
		const result = await run(THREE)
		expect(result.success).toBe(true)
		expect(result.output).toMatch(/^The user did not answer these questions\./)
		expect(result.data).toMatchObject({ answered: false })
	})

	it('treats an answer addressed to another question as no answer at all', async () => {
		const { run } = setup({
			action: 'answer_question',
			selectedOptionIds: [],
			questionId: 'toolu_stale',
			answers: [{ questionId: `${TOOL_USE_ID}#0`, selectedOptionIds: ['opt_1'] }],
		})
		const result = await run(THREE)
		expect(result.output).toMatch(/^The user did not answer these questions\./)
	})

	it('ends the whole batch when the user declines', async () => {
		const { run } = setup({ action: 'abort', reason: 'no' })
		const result = await run(THREE)
		expect(result.success).toBe(false)
		expect(result.data).toMatchObject({ answered: false, declined: true })
	})

	it('takes a one-question answer in the batch form and quotes it the old way', async () => {
		const { run } = setup({
			action: 'answer_question',
			selectedOptionIds: [],
			answers: [{ questionId: `${TOOL_USE_ID}#0`, selectedOptionIds: ['opt_2'] }],
		})
		const result = await run(q('Which audience?', 'Audience'))
		expect(result.output).toBe('User answered "Which audience?": "Two"')
	})
})

describe('ask_user_question resumed with a partly answered batch', () => {
	it('returns the carried answers without asking again', async () => {
		const { requests, run, pendingAnswers } = setup({ action: 'continue' })
		pendingAnswers.set(TOOL_USE_ID, {
			action: 'answer_question',
			selectedOptionIds: [],
			questionId: TOOL_USE_ID,
			answers: [
				{ questionId: `${TOOL_USE_ID}#0`, selectedOptionIds: ['opt_1'] },
				{
					questionId: `${TOOL_USE_ID}#2`,
					selectedOptionIds: [],
					freeText: 'ops',
				},
			],
		})
		const result = await run(THREE)
		expect(requests).toHaveLength(0)
		expect(result.output).toContain('The user answered 2 of 3 questions:')
		expect(result.output).toContain('Purpose (own words): "ops"')
		expect(result.output).toContain('Environment: not answered')
	})
})
