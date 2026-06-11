import { describe, expect, it } from 'vitest'

import type { TaskGateway } from '../../../types/agent/gateway.js'
import type {
	HITLDecisionRequest,
	HITLResumeDecision,
	ResumeHandler,
} from '../../../types/hitl/index.js'
import type { RunId } from '../../../types/ids/index.js'
import type { ToolContext, ToolDefinition } from '../../../types/tool/index.js'
import { buildCoordinatorTools } from '../index.js'

const RUN_ID = 'run_ask_user_question_test' as RunId
const TOOL_USE_ID = 'toolu_question_1'

const NO_ANSWER_SENTINEL =
	'The user did not answer this question. Do not assume a choice or consent; proceed on your best judgment or continue without this information.'

function unusedGateway(): TaskGateway {
	return {
		async createTask() {
			throw new Error('not used')
		},
		async waitForTask() {
			throw new Error('not used')
		},
		async continueTask() {},
		cancelTask() {},
		getTask() {
			return undefined
		},
		listTasks() {
			return []
		},
		onTaskCompleted() {
			return () => {}
		},
	}
}

function testToolContext(): ToolContext {
	return {
		runId: RUN_ID,
		workingDirectory: '/tmp/test',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		toolUseId: TOOL_USE_ID,
	}
}

function contextWithoutToolUseId(): ToolContext {
	return {
		runId: RUN_ID,
		workingDirectory: '/tmp/test',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
}

function buildTools(opts: { resumeHandler?: ResumeHandler; runId?: RunId }): ToolDefinition[] {
	return buildCoordinatorTools({
		gateway: unusedGateway(),
		workingDirectory: '/tmp/test',
		allowedAgentIds: ['sales-strategy'],
		...opts,
	})
}

function askTool(handler: ResumeHandler): ToolDefinition {
	const tools = buildTools({ resumeHandler: handler, runId: RUN_ID })
	const tool = tools.find((t) => t.name === 'ask_user_question')
	if (!tool) throw new Error('ask_user_question tool missing from coordinator builder')
	return tool
}

const baseInput = {
	question: 'Who is the audience?',
	options: [
		{ label: 'Board (Recommended)', description: 'Executive framing, business outcomes first' },
		{ label: 'Engineering team' },
		{ label: 'Customer' },
	],
}

/**
 * Mirror the registry's execution path: input is validated/defaulted
 * through the tool's own zod schema before reaching execute.
 */
async function executeAsk(opts: {
	decision: HITLResumeDecision
	input?: unknown
	context?: ToolContext
}) {
	const requests: HITLDecisionRequest[] = []
	const tool = askTool(async (request) => {
		requests.push(request)
		return opts.decision
	})
	const parsed = tool.inputSchema.parse(opts.input ?? baseInput)
	const result = await tool.execute(parsed, opts.context ?? testToolContext())
	return { result, requests }
}

describe('coordinator ask_user_question registration', () => {
	const noopHandler: ResumeHandler = async () => ({ action: 'continue' })

	it('registers the tool only when BOTH resumeHandler and runId are present', () => {
		const present = buildTools({ resumeHandler: noopHandler, runId: RUN_ID })
		expect(present.some((t) => t.name === 'ask_user_question')).toBe(true)
	})

	it('does not register without a runId', () => {
		const tools = buildTools({ resumeHandler: noopHandler })
		expect(tools.some((t) => t.name === 'ask_user_question')).toBe(false)
	})

	it('does not register without a resumeHandler', () => {
		const tools = buildTools({ runId: RUN_ID })
		expect(tools.some((t) => t.name === 'ask_user_question')).toBe(false)
	})

	it('does not register with neither', () => {
		const tools = buildTools({})
		expect(tools.some((t) => t.name === 'ask_user_question')).toBe(false)
	})

	it('pins the gate-relevant flags — custom, read-only, non-destructive, NOT concurrency-safe', () => {
		const tool = askTool(noopHandler)
		expect(tool.category).toBe('custom')
		expect(tool.permissions).toEqual([])
		expect(tool.isReadOnly?.({})).toBe(true)
		expect(tool.isDestructive?.({})).toBe(false)
		// The single most load-bearing flag: hosts key park registries by
		// runId, so intra-turn questions MUST serialize. true would let
		// executeBatch open concurrent parks that clobber and deadlock.
		expect(tool.isConcurrencySafe?.({})).toBe(false)
	})
})

describe('coordinator ask_user_question input schema', () => {
	const noopHandler: ResumeHandler = async () => ({ action: 'continue' })

	it('rejects fewer than 2 options and more than 4', () => {
		const tool = askTool(noopHandler)
		expect(
			tool.inputSchema.safeParse({
				question: 'Pick?',
				options: [{ label: 'Only one' }],
			}).success,
		).toBe(false)
		expect(
			tool.inputSchema.safeParse({
				question: 'Pick?',
				options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: 'D' }, { label: 'E' }],
			}).success,
		).toBe(false)
	})

	it('rejects headers longer than 24 characters', () => {
		const tool = askTool(noopHandler)
		expect(
			tool.inputSchema.safeParse({
				...baseInput,
				header: 'x'.repeat(25),
			}).success,
		).toBe(false)
		expect(
			tool.inputSchema.safeParse({
				...baseInput,
				header: 'Audience',
			}).success,
		).toBe(true)
	})
})

describe('coordinator ask_user_question request synthesis', () => {
	it('synthesizes the park request from its own context — questionId = toolUseId', async () => {
		const { requests } = await executeAsk({
			decision: { action: 'answer_question', selectedOptionIds: ['opt_1'] },
		})

		expect(requests).toHaveLength(1)
		const request = requests[0]
		if (!request || request.type !== 'user_question') {
			throw new Error('expected a user_question request')
		}
		expect(request.runId).toBe(RUN_ID)
		expect(request.checkpointId).toBe(`cp_question_${TOOL_USE_ID}`)
		expect(request.question.questionId).toBe(TOOL_USE_ID)
		expect(request.question.question).toBe('Who is the audience?')
		// zod defaults applied by the schema parse, exactly like the registry
		expect(request.question.multiSelect).toBe(false)
		expect(request.question.allowFreeText).toBe(true)
		expect(request.question.options).toEqual([
			{
				id: 'opt_1',
				label: 'Board (Recommended)',
				description: 'Executive framing, business outcomes first',
			},
			{ id: 'opt_2', label: 'Engineering team' },
			{ id: 'opt_3', label: 'Customer' },
		])
	})

	it('threads header / multiSelect / allowFreeText through verbatim', async () => {
		const { requests } = await executeAsk({
			decision: { action: 'answer_question', selectedOptionIds: ['opt_1'] },
			input: {
				...baseInput,
				header: 'Audience',
				multiSelect: true,
				allowFreeText: false,
			},
		})
		const request = requests[0]
		if (!request || request.type !== 'user_question') {
			throw new Error('expected a user_question request')
		}
		expect(request.question.header).toBe('Audience')
		expect(request.question.multiSelect).toBe(true)
		expect(request.question.allowFreeText).toBe(false)
	})

	it('hard-fails without ctx.toolUseId and never parks', async () => {
		const { result, requests } = await executeAsk({
			decision: { action: 'answer_question', selectedOptionIds: ['opt_1'] },
			context: contextWithoutToolUseId(),
		})
		expect(result.success).toBe(false)
		expect(result.error).toContain('toolUseId')
		expect(requests).toHaveLength(0)
	})
})

describe('coordinator ask_user_question decision -> output mapping', () => {
	it('quotes question and selected label verbatim, stripping " (Recommended)"', async () => {
		const { result } = await executeAsk({
			decision: { action: 'answer_question', selectedOptionIds: ['opt_1'] },
		})
		expect(result.success).toBe(true)
		expect(result.output).toBe('User answered "Who is the audience?": "Board"')
		expect(result.data).toEqual({
			question: 'Who is the audience?',
			selected: [{ id: 'opt_1', label: 'Board' }],
			answered: true,
		})
	})

	it('joins multiple selected labels', async () => {
		const { result } = await executeAsk({
			decision: { action: 'answer_question', selectedOptionIds: ['opt_2', 'opt_3'] },
			input: { ...baseInput, multiSelect: true },
		})
		expect(result.success).toBe(true)
		expect(result.output).toBe(
			'User answered "Who is the audience?": "Engineering team", "Customer"',
		)
	})

	it('renders a free-text-only answer "in their own words"', async () => {
		const { result } = await executeAsk({
			decision: {
				action: 'answer_question',
				selectedOptionIds: [],
				freeText: 'A mixed partner audience',
			},
		})
		expect(result.success).toBe(true)
		expect(result.output).toBe(
			'User answered "Who is the audience?" in their own words: "A mixed partner audience"',
		)
		expect(result.data).toEqual({
			question: 'Who is the audience?',
			selected: [],
			freeText: 'A mixed partner audience',
			answered: true,
		})
	})

	it('emits both the selection line and the additional note when both are present', async () => {
		const { result } = await executeAsk({
			decision: {
				action: 'answer_question',
				selectedOptionIds: ['opt_2'],
				freeText: 'Keep it under 10 slides',
			},
		})
		expect(result.success).toBe(true)
		expect(result.output).toBe(
			'User answered "Who is the audience?": "Engineering team"\n' +
				'Additional note from the user: "Keep it under 10 slides"',
		)
	})

	it('maps an empty answer to the explicit no-answer sentinel (answered: false, not consent)', async () => {
		const { result } = await executeAsk({
			decision: { action: 'answer_question', selectedOptionIds: [] },
		})
		expect(result.success).toBe(true)
		expect(result.output).toBe(NO_ANSWER_SENTINEL)
		expect(result.data).toEqual({ question: 'Who is the audience?', answered: false })
	})

	it('treats whitespace-only free text as no answer', async () => {
		const { result } = await executeAsk({
			decision: { action: 'answer_question', selectedOptionIds: [], freeText: '   ' },
		})
		expect(result.output).toBe(NO_ANSWER_SENTINEL)
	})

	it('drops unknown option ids; all-unknown degrades to the sentinel', async () => {
		const { result } = await executeAsk({
			decision: { action: 'answer_question', selectedOptionIds: ['opt_9'] },
		})
		expect(result.output).toBe(NO_ANSWER_SENTINEL)
	})

	it('maps abort to a declined, turn-ending result', async () => {
		const { result } = await executeAsk({
			decision: { action: 'abort', reason: 'user dismissed' },
		})
		expect(result.success).toBe(false)
		expect(result.output).toBe(
			'The user declined to answer and asked to stop. Acknowledge briefly and end your turn.',
		)
		expect(result.data).toEqual({
			question: 'Who is the audience?',
			answered: false,
			declined: true,
		})
	})

	it('converts misdirected legacy decisions to the sentinel (rolling-deploy guard)', async () => {
		for (const decision of [
			{ action: 'continue' },
			{ action: 'approve_tools' },
			{ action: 'approve_plan' },
		] as const) {
			const { result } = await executeAsk({ decision })
			expect(result.success).toBe(true)
			expect(result.output).toBe(NO_ANSWER_SENTINEL)
		}
	})

	it('degrades a questionId mismatch to the sentinel — never fabricates against the wrong question', async () => {
		const { result } = await executeAsk({
			decision: {
				action: 'answer_question',
				selectedOptionIds: ['opt_1'],
				questionId: 'toolu_some_other_question',
			},
		})
		expect(result.success).toBe(true)
		expect(result.output).toBe(NO_ANSWER_SENTINEL)
	})

	it('accepts the answer when questionId matches the asking toolUseId', async () => {
		const { result } = await executeAsk({
			decision: {
				action: 'answer_question',
				selectedOptionIds: ['opt_1'],
				questionId: TOOL_USE_ID,
			},
		})
		expect(result.success).toBe(true)
		expect(result.output).toBe('User answered "Who is the audience?": "Board"')
	})
})
