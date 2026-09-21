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
import {
	createAssistantMessage,
	createToolMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import type { Message } from '../../../types/message/index.js'
import type { ChatCompletionParams, LLMProvider, MockTurn } from '../../../types/provider/index.js'
import type { AnswerReviewContext } from '../../../types/session/answer-review.js'
import { generateTurnId } from '../../../utils/id.js'
import { drainQuery } from '../index.js'
import { SteeringBinding } from '../steering.js'
import { turnCheckpoints } from './support/session.js'

const roots: string[] = []
afterEach(async () => {
	await removeTempDirs(roots.splice(0))
})
async function fixture(provider: LLMProvider) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-review-request-'))
	roots.push(workingDirectory)
	return {
		provider,
		turnId: generateTurnId(),
		tools: new ToolRegistry(),
		agentId: 'review-request',
		agentName: 'Review request',
		workingDirectory,
		turnConfig: { model: 'mock', tokenBudget: 10000, maxIterations: 4, timeoutMs: 5000 },
		tenantId: fixtureId.tenant('review-request'),
		projectId: fixtureId.project('review-request'),
		sessionId: fixtureId.session('review-request'),
		topicId: fixtureId.topic('review-request'),
		messages: [createUserMessage('Use the supplied reference.')],
		sessionLog: new InMemorySessionLog({ sessionId: fixtureId.session('review-request') }),
		retry: false,
	} satisfies Parameters<typeof drainQuery>[0]
}
const evidence = (context: AnswerReviewContext) =>
	context.requestMessages?.find(
		(m) =>
			m.role === 'user' && m.source?.type === 'runtime-context' && m.source.kind === 'step-context',
	)?.content

it.each(['prose', 'tool', 'native'] as const)(
	'reviews the actual changing request for %s output without persisting it',
	async (mode) => {
		const turns: MockTurn[] = ['WRONG', 'B42'].map((code) =>
			mode === 'tool'
				? { toolCalls: [{ name: 'structured_output', args: { code } }] }
				: { text: mode === 'native' ? JSON.stringify({ code }) : code },
		)
		const provider = new MockLLMProvider({
			turns,
			capabilities: {
				supportsTools: true,
				supportsFunctionCalling: true,
				supportsStreaming: true,
				supportsVision: true,
				supportsNativeStructuredOutput: true,
			},
		})
		const params = await fixture(provider)
		const requests: Array<readonly Message[]> = []
		const review = vi.fn((value: unknown, context: AnswerReviewContext) => {
			const expected = context.iteration === 1 ? 'A17' : 'B42'
			expect(context.latestUserMessage).toEqual(params.messages[0])
			expect(context.latestUserMessage).not.toBe(params.messages[0])
			if (context.latestUserMessage) context.latestUserMessage.content = 'Mutated reviewer copy'
			expect(evidence(context)).toContain(`Request-only reference: ${expected}`)
			expect(context.requestMessages).toEqual(provider.requests.at(-1)?.messages)
			expect(context.requestMessages).not.toBe(provider.requests.at(-1)?.messages)
			expect(
				context.messages.some(
					(m) =>
						m.role === 'user' &&
						m.source?.type === 'runtime-context' &&
						m.source.kind === 'step-context',
				),
			).toBe(false)
			expect(context.requestMessages?.at(-1)?.content).toContain(
				`Request-only reference: ${expected}`,
			)
			requests.push(context.requestMessages ?? [])
			const code = mode === 'prose' ? value : z.object({ code: z.string() }).parse(value).code
			return code === expected
				? { accept: true as const }
				: {
						accept: false as const,
						feedback: 'The identifier differs from the supplied reference. Copy it exactly.',
					}
		})
		const result = await drainQuery({
			...params,
			prepareStep: ({ stepNumber }) => ({
				context: `Request-only reference: ${stepNumber === 1 ? 'A17' : 'B42'}`,
			}),
			...(mode === 'prose'
				? { reviewAnswer: review }
				: { structuredOutput: { schema: z.object({ code: z.string() }), mode, review } }),
		})
		expect(result.stopReason, JSON.stringify(result.lastError)).toBe('end_turn')
		expect(review).toHaveBeenCalledTimes(2)
		expect(requests[0]?.at(-1)?.content).toContain('Request-only reference: A17')
		expect(requests[1]?.at(-1)?.content).toContain('Request-only reference: B42')
		if (mode !== 'prose') expect(result.structuredOutput).toEqual({ code: 'B42' })
		expect(JSON.stringify(result.messages)).not.toContain('Request-only reference:')
		const checkpoints = await turnCheckpoints(params)
		expect(checkpoints.length).toBeGreaterThan(0)
		expect(JSON.stringify(checkpoints)).not.toContain('requestMessages')
		expect(JSON.stringify(checkpoints)).not.toContain('Request-only reference:')
		const recorded = JSON.stringify(await params.sessionLog.readAll())
		expect(recorded).not.toContain('Request-only reference:')
	},
)

it('isolates nested reviewer mutations from provider requests and canonical history', async () => {
	const provider = new MockLLMProvider({ turns: [{ text: 'answer' }] })
	const params = await fixture(provider)
	const original = [
		createUserMessage('Read'),
		createAssistantMessage(null, [
			{ id: 'read', type: 'function', function: { name: 'read', arguments: '{}' } },
		]),
		createToolMessage([{ type: 'text', text: 'original' }], 'read'),
	]
	const result = await drainQuery({
		...params,
		messages: original,
		reviewAnswer: (_answer, context) => {
			const tool = context.requestMessages?.find((m) => m.role === 'tool')
			if (!tool || !Array.isArray(tool.content) || tool.content[0]?.type !== 'text')
				throw new Error('Missing tool text')
			Object.assign(tool.content[0], { text: 'mutated' })
			const call = context.requestMessages?.find((m) => m.role === 'assistant')
			if (!call?.toolCalls?.[0]) throw new Error('Missing tool call')
			call.toolCalls[0].function.arguments = '{"mutated":true}'
			return { accept: true }
		},
	})
	expect(result.stopReason, JSON.stringify(result.lastError)).toBe('end_turn')
	expect(JSON.stringify(provider.requests[0]?.messages)).not.toContain('mutated')
	expect(JSON.stringify(result.messages)).not.toContain('mutated')
	expect(JSON.stringify(original)).not.toContain('mutated')
})

it.each(
	(['prose', 'tool', 'native'] as const).flatMap((mode) =>
		(['inbound', 'steering'] as const).map((ingress) => ({ mode, ingress })),
	),
)(
	'binds $mode review to dispatch input before a later $ingress arrival',
	async ({ mode, ingress }) => {
		const pending: Message[] = []
		const steering = new SteeringBinding()
		const provider = new MockLLMProvider({
			capabilities: {
				supportsNativeStructuredOutput: true,
				supportsTools: true,
				supportsFunctionCalling: true,
				supportsStreaming: true,
				supportsVision: true,
			},
			nextTurn: (_request, index) => {
				if (index === 0) {
					if (ingress === 'inbound') pending.push(createUserMessage('Use the NEW instruction.'))
					else steering.steer('Use the NEW instruction.')
				}
				return mode === 'tool'
					? { toolCalls: [{ name: 'structured_output', args: { code: 'candidate' } }] }
					: { text: mode === 'native' ? '{"code":"candidate"}' : 'candidate' }
			},
		})
		const params = await fixture(provider)
		const observed: string[] = []
		const review = (_value: unknown, context: AnswerReviewContext) => {
			observed.push(context.latestUserMessage?.content ?? 'missing')
			return { accept: true as const }
		}
		const run = await drainQuery({
			...params,
			steering,
			inboundMessages: () => pending.splice(0),
			...(mode === 'prose'
				? { reviewAnswer: review }
				: {
						structuredOutput: { schema: z.object({ code: z.string() }), mode, review },
					}),
		})
		expect(run.stopReason, run.lastError).toBe('end_turn')
		expect(observed).toEqual(['Use the supplied reference.', 'Use the NEW instruction.'])
	},
)

it('captures the image-repaired dispatch, not the rejected request', async () => {
	const script = new MockLLMProvider({ turns: [{ text: 'recovered' }] })
	const requests: ChatCompletionParams[] = []
	const provider: LLMProvider = {
		id: 'image-fixture',
		name: 'Image fixture',
		async *chatStream(params) {
			requests.push(params)
			if (requests.length === 1)
				throw new ProviderRequestError({
					kind: 'bad_request',
					providerId: 'image-fixture',
					status: 400,
					providerCode: 'invalid_image',
				})
			yield* script.chatStream(params)
		},
	}
	const params = await fixture(provider)
	const review = vi.fn((_answer: string, context: AnswerReviewContext) => {
		expect(context.requestMessages).toEqual(requests[1]?.messages)
		expect(context.requestMessages).not.toEqual(requests[0]?.messages)
		return { accept: true as const }
	})
	const result = await drainQuery({
		...params,
		messages: [createUserMessage('Inspect this.', [{ data: 'bad-image', mediaType: 'image/png' }])],
		reviewAnswer: review,
	})
	expect(result.stopReason, JSON.stringify(result.lastError)).toBe('end_turn')
	expect(requests).toHaveLength(2)
	expect(review).toHaveBeenCalledOnce()
})

it.each(['inbound', 'steering'] as const)(
	'reconsiders a tool-mode answer on %s without a reviewer',
	async (ingress) => {
		const pending: Message[] = []
		const steering = new SteeringBinding()
		const provider = new MockLLMProvider({
			nextTurn: (_request, index) => {
				if (index === 0) {
					if (ingress === 'inbound') pending.push(createUserMessage('Use B42 now.'))
					else steering.steer('Use B42 now.')
				}
				return {
					toolCalls: [{ name: 'structured_output', args: { code: index === 0 ? 'A17' : 'B42' } }],
				}
			},
		})
		const params = await fixture(provider)
		const run = await drainQuery({
			...params,
			steering,
			inboundMessages: () => pending.splice(0),
			structuredOutput: { schema: z.object({ code: z.string() }), mode: 'tool' },
		})
		expect(run.stopReason, run.lastError).toBe('end_turn')
		expect(provider.requests).toHaveLength(2)
		expect(JSON.stringify(provider.requests[1]?.messages)).toContain('Use B42 now.')
		expect(run.structuredOutput).toEqual({ code: 'B42' })
	},
)

it('does not publish a tool-mode candidate if the final inbound check cancels the run', async () => {
	const controller = new AbortController()
	const provider = new MockLLMProvider({
		turns: [{ toolCalls: [{ name: 'structured_output', args: { code: 'A17' } }] }],
	})
	const params = await fixture(provider)
	const run = await drainQuery({
		...params,
		signal: controller.signal,
		inboundMessages: () => {
			if (provider.requests.length) controller.abort()
			return []
		},
		structuredOutput: { schema: z.object({ code: z.string() }), mode: 'tool' },
	})
	expect(run.stopReason).toBe('cancelled')
	expect(run.structuredOutput).toBeUndefined()
})

it('rebuilds request evidence on the next turn instead of retaining the old snapshot', async () => {
	// A checkpoint holds no messages, and request-only evidence never reaches
	// the session log: the next turn of the session folds the log and builds
	// its own request evidence.
	const provider = new MockLLMProvider({ turns: [{ text: 'wrong' }] })
	const params = await fixture(provider)
	const first = await drainQuery({
		...params,
		prepareStep: () => ({ context: 'Old request-only source: A17' }),
		maxAnswerReviews: 0,
		reviewAnswer: (_answer, context) => {
			expect(evidence(context)).toContain('Old request-only source: A17')
			return { accept: false, feedback: 'Read the next supplied reference carefully.' }
		},
	})
	expect(first.stopReason).toBe('answer_rejected')
	const checkpoints = await turnCheckpoints(params)
	const checkpoint = checkpoints.find((c) => c.review.answerAttempts === 1)
	if (!checkpoint) throw new Error('Missing rejection checkpoint')
	expect(JSON.stringify(checkpoint)).not.toContain('Old request-only source:')
	const history = await readFoldedHistory(params.sessionLog)
	expect(JSON.stringify(history)).not.toContain('Old request-only source:')
	const review = vi.fn((_answer: string, context: AnswerReviewContext) => {
		expect(evidence(context)).toContain('New request-only source: B42')
		expect(JSON.stringify(context.requestMessages)).not.toContain('Old request-only source:')
		return { accept: true as const }
	})
	const next = await drainQuery({
		...params,
		turnId: generateTurnId(),
		messages: [createUserMessage('Try again with the new reference.')],
		tools: new ToolRegistry(),
		provider: new MockLLMProvider({ turns: [{ text: 'B42' }] }),
		prepareStep: () => ({ context: 'New request-only source: B42' }),
		maxAnswerReviews: 1,
		reviewAnswer: review,
	})
	expect(next.stopReason, next.lastError).toBe('end_turn')
	expect(review).toHaveBeenCalledOnce()
})
