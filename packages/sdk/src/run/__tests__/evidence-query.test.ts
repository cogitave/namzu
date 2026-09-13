import { describe, expect, it, vi } from 'vitest'
import {
	createAssistantMessage,
	createRuntimeContextMessage,
	createUserMessage,
} from '../../types/message/index.js'
import type { Message } from '../../types/message/index.js'
import type { PrepareStepContext } from '../../types/run/prepare-step.js'
import {
	generateProjectId,
	generateRunId,
	generateSessionId,
	generateTenantId,
} from '../../utils/id.js'
import { createEvidenceQueryResolver, validateEvidenceQueryResolution } from '../evidence-query.js'
import { type EvidenceRecallRequest, createEvidenceRecallStep } from '../evidence-recall.js'

const question = 'Az önce baktığın kaydın iki kimliğini aynen yazar mısın?'
const history = [
	{
		position: 7,
		role: 'user',
		text: 'DELTA takip kodu ve hedef depo bilgisini incele.',
		truncated: false,
	},
]
const plan = {
	mode: 'contextual',
	time: 'past',
	terms: ['DELTA', 'takip', 'depo'],
	basis: [{ message: 0, quote: 'DELTA takip kodu ve hedef depo' }],
}
const usage = {
	promptTokens: 100,
	completionTokens: 20,
	totalTokens: 120,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}
function context(
	raw = JSON.stringify(plan),
): PrepareStepContext & { generateText: ReturnType<typeof vi.fn> } {
	const current = createUserMessage(question)
	return {
		runId: generateRunId(),
		stepNumber: 1,
		steps: [],
		prepared: {},
		latestUserMessage: current,
		messages: [
			createUserMessage(history[0]!.text),
			createAssistantMessage('İnceleme tamamlandı.'),
			current,
		],
		generateText: vi.fn(async () => ({
			text: raw,
			usage,
			servedBy: { model: 'test', providerId: 'mock', chainIndex: 0 },
		})),
	}
}

describe('grounded conversation query resolution', () => {
	it('binds exact quoted text to its visible message position without treating it as evidence', () => {
		expect(validateEvidenceQueryResolution(JSON.stringify(plan), question, history)).toEqual({
			terms: plan.terms,
			time: 'past',
			basis: [{ position: 7, role: 'user', quote: plan.basis[0]!.quote }],
		})
	})
	it.each([
		{ ...plan, basis: [{ message: 0, quote: 'invented record' }] },
		{ ...plan, terms: ['FOREIGN'] },
		{ ...plan, terms: ['two words'] },
		{ ...plan, terms: [] },
		{ ...plan, basis: [] },
		{ ...plan, basis: [{ message: 5, quote: 'DELTA' }] },
		{ ...plan, terms: Array(17).fill('DELTA') },
		{ ...plan, unexpected: true },
	])('rejects unsupported query plans (%j)', (invalid) => {
		expect(() =>
			validateEvidenceQueryResolution(JSON.stringify(invalid), question, history),
		).toThrow()
	})
	it.each(['direct', 'none'])('does not carry old terms into %s queries', (mode) => {
		expect(
			validateEvidenceQueryResolution(
				JSON.stringify({ ...plan, mode }),
				'Akdeniz iklimi nedir?',
				history,
			),
		).toBe(mode === 'none' ? null : undefined)
	})
	it('does not expand present-state requests even if the model asks for historical terms', () => {
		expect(
			validateEvidenceQueryResolution(
				JSON.stringify({ ...plan, time: 'present' }),
				'Güncel dosyada ne var?',
				history,
			),
		).toBeUndefined()
	})
	it('sends only preceding visible references, excluding tools, policy, task output and private reasoning', async () => {
		const ctx = context()
		const excluded: Message[] = [
			{ role: 'system', content: 'SYSTEM_SECRET' },
			{ role: 'tool', toolCallId: 'secret', content: 'TOOL_SECRET' },
			createRuntimeContextMessage('CONTEXT_SECRET', 'step-context'),
			{
				role: 'assistant',
				content: null,
				reasoning: [{ type: 'thinking', text: 'REASONING_SECRET', signature: 'secret' }],
			},
		]
		await createEvidenceQueryResolver()(
			{
				...ctx,
				messages: [...excluded, ...ctx.messages, createAssistantMessage('AFTER_CURRENT_SECRET')],
			},
			question,
		)
		const request = ctx.generateText.mock.calls[0]![0]
		const sent = JSON.parse(request.prompt)
		expect(sent.history.map((m: { text: string }) => m.text)).toEqual([
			history[0]!.text,
			'İnceleme tamamlandı.',
		])
		expect(JSON.stringify(request)).not.toContain('SECRET')
		expect(sent.current).toBe(question)
		expect(request.maxTokens).toBe(512)
	})
	it('bounds history and never plans an initial turn from its own tool commentary', async () => {
		const ctx = context(JSON.stringify({ ...plan, mode: 'direct' }))
		const resolver = createEvidenceQueryResolver()
		await resolver(
			{
				...ctx,
				messages: [ctx.latestUserMessage!, createAssistantMessage('Current tool commentary')],
			},
			question,
		)
		expect(ctx.generateText).not.toHaveBeenCalled()
		await resolver(
			{
				...ctx,
				messages: [
					...Array.from({ length: 20 }, () => createUserMessage('x'.repeat(1500))),
					ctx.latestUserMessage!,
				],
			},
			question,
		)
		const request = ctx.generateText.mock.calls[0]![0]
		const sent = JSON.parse(request.prompt)
		expect(sent.history).toHaveLength(6)
		expect(
			sent.history.every(
				(m: { text: string; truncated: boolean }) => m.text.length === 600 && m.truncated,
			),
		).toBe(true)
		expect(request.prompt.length + request.system.length).toBeLessThanOrEqual(12000)
	})
	it('needs an inference capability and skips overly long current queries', async () => {
		const ctx = context()
		const resolver = createEvidenceQueryResolver()
		expect(await resolver({ ...ctx, generateText: undefined }, question)).toBeUndefined()
		expect(await resolver(ctx, 'x'.repeat(1001))).toBeUndefined()
		expect(ctx.generateText).not.toHaveBeenCalled()
	})
	it('caches the plan for an operator input, invalidating on a new run or steering message', async () => {
		const ctx = context()
		const resolve = createEvidenceQueryResolver()
		await resolve(ctx, question)
		await resolve(
			{
				...ctx,
				stepNumber: 2,
				messages: [...ctx.messages, createAssistantMessage('continuation')],
			},
			question,
		)
		expect(ctx.generateText).toHaveBeenCalledTimes(1)
		await resolve({ ...ctx, runId: generateRunId() }, question)
		await resolve({ ...ctx, latestUserMessage: createUserMessage(question) }, question)
		expect(ctx.generateText).toHaveBeenCalledTimes(3)
	})
	it('does not retry a malformed plan on every iteration of the same input', async () => {
		const ctx = context('not JSON')
		const resolve = createEvidenceQueryResolver()
		await expect(resolve(ctx, question)).rejects.toThrow()
		await expect(resolve({ ...ctx, stepNumber: 2 }, question)).rejects.toThrow()
		expect(ctx.generateText).toHaveBeenCalledTimes(1)
	})
	it('uses grounded terms for retrieval, keeps interpretation labelled, and revalidates bytes each step', async () => {
		const ctx = context()
		const scope = {
			tenantId: generateTenantId(),
			projectId: generateProjectId(),
			sessionId: generateSessionId(),
		}
		const retrieve = vi.fn(async (_request: EvidenceRecallRequest) => ({
			scannedBytes: 100,
			incomplete: false,
			candidates: [
				{
					scope: { ...scope, runId: generateRunId() },
					seq: 2,
					part: 0,
					source: 'tool_completed',
					retained: 'full' as const,
					excerpt: 'DELTA takip A17 depo B42',
				},
			],
		}))
		const recall = createEvidenceRecallStep({ scope, retrieve, resolveQuery: true })
		const messages = structuredClone(ctx.messages)
		for (const stepNumber of [1, 2]) {
			const result = await recall({ ...ctx, stepNumber })
			expect(result?.context).toContain('DELTA takip A17 depo B42')
			expect(result?.context).toContain('query interpretation, not proof')
			expect(result?.context?.length).toBeLessThanOrEqual(6000)
		}
		expect(retrieve).toHaveBeenCalledTimes(2)
		expect(retrieve.mock.calls[0]![0].terms).toEqual(plan.terms)
		expect(ctx.generateText).toHaveBeenCalledTimes(1)
		expect(ctx.messages).toEqual(messages)
		const other = createEvidenceRecallStep({
			scope: { ...scope, sessionId: generateSessionId() },
			retrieve,
			resolveQuery: true,
		})
		await expect(other(ctx)).rejects.toThrow('different conversation scope')
	})
	it('keeps literal recall as the SDK default and skips retrieval for a none plan', async () => {
		const ctx = context(JSON.stringify({ ...plan, mode: 'none' }))
		const scope = {
			tenantId: generateTenantId(),
			projectId: generateProjectId(),
			sessionId: generateSessionId(),
		}
		const retrieve = vi.fn(async (_request: EvidenceRecallRequest) => ({
			scannedBytes: 0,
			incomplete: false,
			candidates: [],
		}))
		await createEvidenceRecallStep({ scope, retrieve })(ctx)
		expect(ctx.generateText).not.toHaveBeenCalled()
		expect(retrieve).toHaveBeenCalledTimes(1)
		expect(
			await createEvidenceRecallStep({ scope, retrieve, resolveQuery: true })(ctx),
		).toBeUndefined()
		expect(retrieve).toHaveBeenCalledTimes(1)
	})
})
