import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { fixtureId } from '../../../test-support/ids.js'
import { createUserMessage } from '../../../types/message/index.js'
import { ProviderError } from '../../../types/provider/errors.js'
import type { MockTurn } from '../../../types/provider/index.js'
import type { AnswerReviewContext } from '../../../types/session/answer-review.js'
import { drainQuery } from '../index.js'

const roots: string[] = []
afterEach(async () => {
	await removeTempDirs(roots.splice(0))
})
const usage = (totalTokens: number) => ({
	promptTokens: totalTokens,
	completionTokens: 0,
	totalTokens,
	cachedTokens: 0,
	cacheWriteTokens: 0,
})
const input = {
	system: 'Judge only the supplied candidate.',
	prompt: 'This is explicit review input.',
}
async function fixture(turns: MockTurn[]) {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-review-inference-'))
	roots.push(cwd)
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
	return {
		provider,
		tools: new ToolRegistry(),
		agentId: 'review-inference',
		agentName: 'Review inference',
		workingDirectory: cwd,
		turnConfig: {
			model: 'main-model',
			effort: 'low',
			tokenBudget: 1000,
			maxIterations: 4,
			timeoutMs: 5000,
		},
		messages: [createUserMessage('PRIVATE operator input')],
		tenantId: fixtureId.tenant('review-inference'),
		projectId: fixtureId.project('review-inference'),
		sessionId: fixtureId.session('review-inference'),
		topicId: fixtureId.topic('review-inference'),
		retry: false,
	} satisfies Parameters<typeof drainQuery>[0]
}

it.each(['prose', 'tool', 'native'] as const)(
	'meters %s review independently of main steps and gives each correction a fresh capability',
	async (mode) => {
		const answer = (code: string, tokens: number): MockTurn => ({
			...(mode === 'tool'
				? { toolCalls: [{ name: 'structured_output', args: { code } }] }
				: { text: mode === 'native' ? JSON.stringify({ code }) : code }),
			usage: usage(tokens),
		})
		const params = await fixture([
			answer('wrong', 10),
			{ text: 'reject', usage: usage(20) },
			answer('correct', 30),
			{ text: 'accept', usage: usage(40) },
		])
		const retained: NonNullable<AnswerReviewContext['generateText']>[] = []
		const review = vi.fn(async (_value: unknown, ctx: AnswerReviewContext) => {
			if (!ctx.generateText) throw new Error('Missing review inference')
			retained.push(ctx.generateText)
			const result = await ctx.generateText(input)
			expect(result.servedBy).toMatchObject({ model: 'selected-model', providerId: 'mock' })
			await expect(ctx.generateText(input)).rejects.toThrow('only one')
			return result.text === 'accept'
				? { accept: true as const }
				: { accept: false as const, feedback: 'Correct the value.' }
		})
		const result = await drainQuery({
			...params,
			prepareStep: () => ({ model: 'selected-model', context: 'PRIVATE transient evidence' }),
			...(mode === 'prose'
				? { reviewAnswer: review }
				: { structuredOutput: { schema: z.object({ code: z.string() }), mode, review } }),
		})
		expect(result.stopReason, JSON.stringify(result.lastError)).toBe('end_turn')
		expect(params.provider.requests).toHaveLength(4)
		expect(review).toHaveBeenCalledTimes(2)
		for (const i of [1, 3]) {
			const request = params.provider.requests[i]
			expect(request?.messages.map((m) => m.content)).toEqual([input.system, input.prompt])
			expect(request).toMatchObject({ model: 'selected-model', effort: 'low', maxTokens: 256 })
			expect(request?.tools).toBeUndefined()
			expect(request?.responseFormat).toBeUndefined()
		}
		expect(result.tokenUsage.totalTokens).toBe(100)
		expect(result.budget?.treeTokens).toBe(100)
		expect(result.steps?.map((s) => s.usage.totalTokens)).toEqual([10, 30])
		for (const generateText of retained)
			await expect(generateText(input)).rejects.toThrow('reviewer has ended')
	},
)

it('accounts a rejecting review before admitting another correction request', async () => {
	const params = await fixture([
		{ text: 'candidate', usage: usage(40) },
		{ text: 'reject', usage: usage(70) },
		{ text: 'must not be requested' },
	])
	const result = await drainQuery({
		...params,
		turnConfig: { ...params.turnConfig, tokenBudget: 100 },
		reviewAnswer: async (_answer, { generateText }) => {
			await generateText!(input)
			return { accept: false, feedback: 'Try again.' }
		},
	})
	expect(params.provider.requests).toHaveLength(2)
	expect(result.budget?.treeTokens).toBe(110)
	expect(result.stopReason).toBe('token_budget')
})

it('revokes inference when a reviewer throws and does not settle the candidate', async () => {
	const params = await fixture([{ text: 'candidate', usage: usage(10) }])
	let retained: AnswerReviewContext['generateText']
	const result = await drainQuery({
		...params,
		reviewAnswer: (_value, context) => {
			retained = context.generateText
			throw new Error('Review is unavailable')
		},
	})
	expect(result.stopReason).toBe('error')
	await expect(retained!(input)).rejects.toThrow('reviewer has ended')
	expect(params.provider.requests).toHaveLength(1)
})

it('charges invalid tool-bearing review output without executing it or accepting the answer', async () => {
	const params = await fixture([
		{ text: 'candidate', usage: usage(10) },
		{
			toolCalls: [{ name: 'write', args: { path: 'forbidden', content: 'wrong' } }],
			usage: usage(20),
		},
	])
	const result = await drainQuery({
		...params,
		reviewAnswer: async (_value, ctx) => {
			await ctx.generateText!(input)
			return { accept: true }
		},
	})
	expect(result.stopReason).toBe('error')
	expect(result.tokenUsage.totalTokens).toBe(30)
	expect(result.budget?.unresolvedRequests).toBe(0)
	expect(result.steps?.flatMap((s) => s.toolCalls)).toEqual([])
})

it('keeps candidate provenance when the review moves onto a fallback provider', async () => {
	const params = await fixture([{ text: 'candidate', usage: usage(10) }])
	const primary = new MockLLMProvider({
		nextTurn: (_params, index) => {
			if (index === 0) return { text: 'candidate', usage: usage(10) }
			throw new ProviderError({ code: 'rate_limit', message: 'review limited' })
		},
	})
	const fallback = new MockLLMProvider({ turns: [{ text: 'accept', usage: usage(20) }] })
	const result = await drainQuery({
		...params,
		provider: primary,
		fallbackProviders: [{ provider: fallback, model: 'fallback-model' }],
		reviewAnswer: async (_value, ctx) => {
			const response = await ctx.generateText!(input)
			expect(response.servedBy).toMatchObject({ model: 'fallback-model', chainIndex: 1 })
			return { accept: true }
		},
	})
	expect(result.stopReason, JSON.stringify(result.lastError)).toBe('end_turn')
	expect(result.steps?.[0]?.servedBy).toMatchObject({ model: 'main-model', chainIndex: 0 })
	expect(result.tokenUsage.totalTokens).toBe(30)
	expect(primary.requests).toHaveLength(2)
	expect(fallback.requests).toHaveLength(1)
})

it.each(['prose', 'native'] as const)(
	'cancels %s review inference and retains its unresolved receipt',
	async (mode) => {
		const controller = new AbortController()
		const params = await fixture([
			{ text: mode === 'native' ? '{"code":"candidate"}' : 'candidate', usage: usage(10) },
		])
		const original = params.provider.chatStream.bind(params.provider)
		let requests = 0
		params.provider.chatStream = async function* (request) {
			if (++requests === 1) {
				yield* original(request)
				return
			}
			controller.abort(new Error('Operator cancelled review'))
			await new Promise(() => {})
		}
		let retained: AnswerReviewContext['generateText']
		const review = async (_value: unknown, ctx: AnswerReviewContext) => {
			retained = ctx.generateText
			await ctx.generateText!(input)
			return { accept: true as const }
		}
		const result = await drainQuery({
			...params,
			signal: controller.signal,
			...(mode === 'prose'
				? { reviewAnswer: review }
				: { structuredOutput: { schema: z.object({ code: z.string() }), mode, review } }),
		})
		expect(result.stopReason).toBe('cancelled')
		expect(requests).toBe(2)
		expect(result.budget?.treeTokens).toBe(10)
		expect(result.budget?.unresolvedRequests).toBe(1)
		await expect(retained!(input)).rejects.toThrow('reviewer has ended')
	},
)
