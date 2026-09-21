import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { readFoldedHistory } from '../../../manager/session/turn-recorder.js'
import { ProviderRequestError } from '../../../provider/errors.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { fixtureId } from '../../../test-support/ids.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { Message } from '../../../types/message/index.js'
import type { LLMProvider } from '../../../types/provider/index.js'
import { generateTurnId } from '../../../utils/id.js'
import { drainQuery } from '../index.js'
import { IterationOrchestrator } from '../iteration/index.js'
import { turnCheckpoints } from './support/session.js'

const roots: string[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	await removeTempDirs(roots.splice(0))
})
async function fixture(provider: LLMProvider, advisor: LLMProvider) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-advisory-request-'))
	roots.push(workingDirectory)
	return {
		provider,
		turnId: generateTurnId(),
		tools: new ToolRegistry(),
		agentId: 'advisory-request',
		agentName: 'Advisory request',
		workingDirectory,
		turnConfig: { model: 'mock', tokenBudget: 10000, maxIterations: 5, timeoutMs: 5000 },
		tenantId: fixtureId.tenant('advisory-request'),
		projectId: fixtureId.project('advisory-request'),
		sessionId: fixtureId.session('advisory-request'),
		topicId: fixtureId.topic('advisory-request'),
		messages: [createUserMessage('Use the supplied reference.')],
		sessionLog: new InMemorySessionLog({ sessionId: fixtureId.session('advisory-request') }),
		retry: false,
		advisory: {
			advisors: [
				{
					id: 'reviewer',
					name: 'Reviewer',
					model: 'mock',
					provider: advisor,
					maxContextTokens: 3000,
				},
			],
			budget: { maxCallsPerRun: 2 },
		},
	} satisfies Parameters<typeof drainQuery>[0]
}
const rows = (messages: readonly Message[]) =>
	String(messages[1]?.content)
		.split('\n')
		.filter((line) => line.startsWith('{'))
		.map((line) => JSON.parse(line))

it.each(['trigger', 'tool'] as const)(
	'supplies current request-only evidence to %s advice and separates later input',
	async (mode) => {
		const pending: Message[] = []
		const main = new MockLLMProvider({
			turns: [
				...[1, 2].map((i) => ({
					toolCalls: [
						{ id: `read-${i}`, name: 'observe', args: {} },
						...(mode === 'tool'
							? [
									{
										id: `consult-${i}`,
										name: 'consult_advisor',
										args: { question: 'Check the reference.' },
									},
								]
							: []),
					],
				})),
				{ text: 'Done.' },
			],
		})
		const advisor = new MockLLMProvider({ turns: [{ text: 'Advice delivered.' }] })
		const params = await fixture(main, advisor)
		let reads = 0
		params.tools.register({
			name: 'observe',
			description: 'Observe.',
			inputSchema: z.object({}),
			execute: async () => {
				reads++
				if (reads === 1) pending.push(createUserMessage('New instruction after dispatch.'))
				return { success: true, output: `Observed cycle ${reads}.` }
			},
		})
		let runner: IterationOrchestrator | undefined
		const getTurn = IterationOrchestrator.prototype.getAdvisoryTurnContext
		vi.spyOn(IterationOrchestrator.prototype, 'getAdvisoryTurnContext').mockImplementation(
			function (this: IterationOrchestrator) {
				runner = this
				return getTurn.call(this)
			},
		)
		const result = await drainQuery({
			...params,
			inboundMessages: () => pending.splice(0),
			prepareStep: ({ stepNumber }) => ({ context: `Transient reference: code-${stepNumber}.` }),
			advisory: {
				...params.advisory,
				enableAgentTool: mode === 'tool',
				...(mode === 'trigger'
					? { triggers: [{ id: 'each', condition: { type: 'on_iteration' as const, everyN: 1 } }] }
					: {}),
			},
		})
		expect(result.stopReason).toBe('end_turn')
		expect(advisor.requests).toHaveLength(2)
		for (const [i, request] of advisor.requests.entries()) {
			const records = rows(request.messages)
			const transient = records.filter((row) => row.source?.kind === 'step-context')
			expect(transient).toHaveLength(1)
			expect(transient[0]).toMatchObject({
				stage: 'request',
				content: expect.stringContaining(`Transient reference: code-${i + 1}.`),
			})
			const currentResult = records.find((row) => row.toolCallId === `read-${i + 1}`)
			if (mode === 'trigger') {
				expect(currentResult).toMatchObject({
					stage: 'subsequent',
					isError: false,
					content: `Observed cycle ${i + 1}.`,
				})
			} else {
				// Same-batch results have not been appended while consult executes.
				expect(currentResult).toBeUndefined()
				expect(
					records.some(
						(row) =>
							row.stage === 'subsequent' &&
							row.toolCalls?.some((call: { id: string }) => call.id === `read-${i + 1}`),
					),
				).toBe(true)
				if (i > 0)
					expect(records.find((row) => row.toolCallId === `read-${i}`)?.stage).toBe('request')
			}
			const newer = records.filter((row) => row.content === 'New instruction after dispatch.')
			if (i === 0 && mode === 'trigger')
				expect(newer).toEqual([expect.objectContaining({ stage: 'subsequent' })])
			if (i === 1) expect(newer).toEqual([expect.objectContaining({ stage: 'request' })])
		}
		expect(reads).toBe(2)
		expect(JSON.stringify(result.messages)).not.toContain('Transient reference:')
		expect(JSON.stringify(await turnCheckpoints(params))).not.toContain('Transient reference:')
		expect(JSON.stringify(await params.sessionLog.readAll())).not.toContain('Transient reference:')
		expect(runner).toBeDefined()
		expect(runner?.getAdvisoryTurnContext()).toBeUndefined()
	},
)

it('includes prepared system/context additions and isolates them from driver mutation', async () => {
	const main = new MockLLMProvider({
		turns: [{ toolCalls: [{ name: 'observe', args: {} }] }, { text: 'Done.' }],
		onRequest: (request) => {
			const evidence = request.messages.find(
				(message) =>
					message.role === 'user' &&
					message.source?.type === 'runtime-context' &&
					message.source.kind === 'step-context',
			)
			if (evidence) evidence.content = 'Mutated by driver after capture.'
		},
	})
	const advisor = new MockLLMProvider({ turns: [{ text: 'Advice.' }] })
	const params = await fixture(main, advisor)
	params.tools.register({
		name: 'observe',
		description: 'Observe.',
		inputSchema: z.object({}),
		execute: async () => ({ success: true, output: 'Observed.' }),
	})
	const result = await drainQuery({
		...params,
		prepareStep: () => ({
			system: 'Prepared instruction.',
			context: 'Original transient evidence.',
		}),
		advisory: {
			...params.advisory,
			triggers: [{ id: 'each', condition: { type: 'on_iteration', everyN: 1 } }],
		},
	})
	expect(result.stopReason).toBe('end_turn')
	const text = String(advisor.requests[0]?.messages[1]?.content)
	expect(text).toContain('Original transient evidence.')
	expect(text).toContain('Prepared instruction.')
	expect(text).toContain('Use the supplied reference.')
	expect(text).not.toContain('Mutated by driver')
	expect(result.messages.some((message) => message.content === 'Use the supplied reference.')).toBe(
		true,
	)
})

it('captures the successful image-repaired request, not the rejected image payload', async () => {
	let calls = 0
	const script = new MockLLMProvider({
		turns: [{ toolCalls: [{ name: 'observe', args: {} }] }, { text: 'Done.' }],
	})
	const provider: LLMProvider = {
		id: 'image-fixture',
		name: 'Image fixture',
		async *chatStream(request) {
			if (++calls === 1)
				throw new ProviderRequestError({
					kind: 'bad_request',
					providerId: 'image-fixture',
					status: 400,
					providerCode: 'invalid_image',
				})
			yield* script.chatStream(request)
		},
	}
	const advisor = new MockLLMProvider({ turns: [{ text: 'Advice.' }] })
	const params = await fixture(provider, advisor)
	params.tools.register({
		name: 'observe',
		description: 'Observe.',
		inputSchema: z.object({}),
		execute: async () => ({ success: true, output: 'Observed.' }),
	})
	const result = await drainQuery({
		...params,
		messages: [createUserMessage('Inspect this.', [{ data: 'bad-image', mediaType: 'image/png' }])],
		prepareStep: () => ({ context: 'Retained transient evidence.' }),
		advisory: {
			...params.advisory,
			triggers: [{ id: 'each', condition: { type: 'on_iteration', everyN: 1 } }],
		},
	})
	expect(result.stopReason, result.lastError).toBe('end_turn')
	expect(calls).toBe(3)
	const records = rows(advisor.requests[0]?.messages ?? [])
	const input = records.find(
		(row) => row.role === 'user' && row.content.startsWith('Inspect this.'),
	)
	expect(input).toBeDefined()
	expect(input).not.toHaveProperty('attachments')
	expect(
		records.some(
			(row) => row.stage === 'request' && row.content.includes('Retained transient evidence.'),
		),
	).toBe(true)
})

it('rebuilds the snapshot on the next turn without persisting the earlier transient source', async () => {
	const advisor = new MockLLMProvider({ turns: [{ text: 'Advice.' }] })
	const main = new MockLLMProvider({
		turns: [{ toolCalls: [{ name: 'observe', args: {} }] }, { text: 'Needs review.' }],
	})
	const params = await fixture(main, advisor)
	params.tools.register({
		name: 'observe',
		description: 'Observe.',
		inputSchema: z.object({}),
		execute: async () => ({ success: true, output: 'Observed.' }),
	})
	const advisory = {
		...params.advisory,
		triggers: [{ id: 'each', condition: { type: 'on_iteration' as const, everyN: 1 } }],
	}
	const first = await drainQuery({
		...params,
		advisory,
		prepareStep: () => ({ context: 'Old transient: A17' }),
		maxAnswerReviews: 0,
		reviewAnswer: () => ({ accept: false, feedback: 'Continue checking.' }),
	})
	expect(first.stopReason).toBe('answer_rejected')
	const checkpoint = (await turnCheckpoints(params)).find((c) => c.review.answerAttempts === 1)
	if (!checkpoint) throw new Error('Missing rejection checkpoint')
	expect(JSON.stringify(checkpoint)).not.toContain('Old transient:')
	expect(JSON.stringify(await readFoldedHistory(params.sessionLog))).not.toContain('Old transient:')
	// The turn settled `answer_rejected`; the session's next turn folds its log.
	const resumed = await drainQuery({
		...params,
		advisory,
		turnId: generateTurnId(),
		messages: [createUserMessage('Check again.')],
		provider: new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'observe', args: {} }] }, { text: 'Done.' }],
		}),
		prepareStep: () => ({ context: 'New transient: B42' }),
	})
	expect(resumed.stopReason, resumed.lastError).toBe('end_turn')
	expect(advisor.requests).toHaveLength(2)
	expect(String(advisor.requests[0]?.messages[1]?.content)).toContain('Old transient: A17')
	expect(String(advisor.requests[1]?.messages[1]?.content)).toContain('New transient: B42')
	expect(String(advisor.requests[1]?.messages[1]?.content)).not.toContain('Old transient:')
	expect(JSON.stringify(resumed.messages)).not.toContain('New transient:')
})

it('releases the captured turn when cancelled during the advisory call', async () => {
	const controller = new AbortController()
	const main = new MockLLMProvider({ turns: [{ toolCalls: [{ name: 'observe', args: {} }] }] })
	const advisor = new MockLLMProvider({
		onRequest: () => controller.abort(new Error('Operator cancelled.')),
		turns: [{ error: { message: 'Advisor cancelled.' } }],
	})
	const params = await fixture(main, advisor)
	params.tools.register({
		name: 'observe',
		description: 'Observe.',
		inputSchema: z.object({}),
		execute: async () => ({ success: true, output: 'Observed.' }),
	})
	let runner: IterationOrchestrator | undefined
	let captured = false
	const getTurn = IterationOrchestrator.prototype.getAdvisoryTurnContext
	vi.spyOn(IterationOrchestrator.prototype, 'getAdvisoryTurnContext').mockImplementation(function (
		this: IterationOrchestrator,
	) {
		runner = this
		const turn = getTurn.call(this)
		captured ||= turn !== undefined
		return turn
	})
	const result = await drainQuery({
		...params,
		signal: controller.signal,
		prepareStep: () => ({ context: 'Cancelled transient evidence.' }),
		advisory: {
			...params.advisory,
			triggers: [{ id: 'each', condition: { type: 'on_iteration', everyN: 1 } }],
		},
	})
	expect(result.stopReason).toBe('cancelled')
	expect(main.requests).toHaveLength(1)
	expect(captured).toBe(true)
	expect(runner?.getAdvisoryTurnContext()).toBeUndefined()
	expect(JSON.stringify(result.messages)).not.toContain('Cancelled transient evidence.')
})
