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
import {
	buildEvidenceQueryInput,
	createEvidenceQueryResolver,
	validateEvidenceQueryResolution,
} from '../evidence-query.js'
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
const wantedTerms = ['DELTA', 'takip', 'depo']
const ids = (current: string, supplied: typeof history, terms: string[]) => {
	const vocabulary = buildEvidenceQueryInput(current, supplied)!.tokens
	return terms.map((term) => {
		const id = vocabulary.indexOf(term)
		expect(id, `Missing test token: ${term}`).toBeGreaterThanOrEqual(0)
		return id
	})
}
const plan = {
	mode: 'contextual',
	time: 'past',
	termIds: ids(question, history, wantedTerms),
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
			terms: wantedTerms,
			time: 'past',
			basis: [{ position: 7, role: 'user', quote: plan.basis[0]!.quote }],
		})
	})
	it('tokenizes a grounded filename using the same units as discovery', () => {
		const quoted = 'Inspect sevkiyatlar.txt for DELTA.'
		expect(
			validateEvidenceQueryResolution(
				JSON.stringify({
					...plan,
					termIds: ids(
						question,
						[{ ...history[0]!, text: quoted }],
						['sevkiyatlar', 'txt', 'DELTA'],
					),
					basis: [{ message: 0, quote: quoted }],
				}),
				question,
				[{ ...history[0]!, text: quoted }],
			),
		).toMatchObject({
			terms: ['sevkiyatlar', 'txt', 'DELTA'],
		})
	})
	it('rejects a supplied word from history the plan did not cite', () => {
		const supplied = [
			...history,
			{ position: 8, role: 'assistant', text: 'FOREIGN', truncated: false },
		]
		expect(() =>
			validateEvidenceQueryResolution(
				JSON.stringify({
					...plan,
					termIds: ids(question, supplied, ['FOREIGN']),
				}),
				question,
				supplied,
			),
		).toThrow('ungrounded token')
	})
	it('preserves Turkish spelling by resolving IDs back to source words', () => {
		const current = 'iki kimliğini aynen yaz'
		const selected = ['DELTA', 'kimliğini']
		expect(
			validateEvidenceQueryResolution(
				JSON.stringify({
					...plan,
					termIds: ids(current, history, selected),
				}),
				current,
				history,
			)?.terms,
		).toEqual(selected)
		expect(buildEvidenceQueryInput(current, history)!.tokens).not.toContain('kimliği')
	})
	it.each([
		{ ...plan, basis: [{ message: 0, quote: 'invented record' }] },
		{ ...plan, termIds: [255] },
		{ ...plan, termIds: ['kimliği'] },
		{ ...plan, termIds: [] },
		{ ...plan, termIds: [-1] },
		{ ...plan, termIds: [1.5] },
		{ ...plan, basis: [] },
		{ ...plan, basis: [{ message: 5, quote: 'DELTA' }] },
		{ ...plan, termIds: Array(17).fill(0) },
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
	it('caps the offered vocabulary and reports words left out', () => {
		const supplied = Array.from({ length: 6 }, (_, position) => ({
			position,
			role: position % 2 ? 'user' : 'assistant',
			truncated: false,
			text: Array.from({ length: 80 }, (_, i) => `w${position}_${i}`).join(' '),
		}))
		const input = buildEvidenceQueryInput('current', supplied)!
		expect(input.tokens).toHaveLength(256)
		expect(input.omittedTokens).toBe(225)
		expect(input.tokens.indexOf('w5_0')).toBeLessThan(input.tokens.indexOf('w1_0'))
		const raw = {
			mode: 'contextual',
			time: 'past',
			termIds: [input.tokens.indexOf('w5_0')],
			basis: [{ message: 5, quote: 'w5_0' }],
		}
		expect(
			validateEvidenceQueryResolution(JSON.stringify(raw), 'current', supplied)?.omittedTokens,
		).toBe(225)
	})
	it('fits JSON escaping and vocabulary rows inside the inference input allowance', async () => {
		const ctx = context(
			JSON.stringify({ mode: 'none', time: 'unspecified', termIds: [], basis: [] }),
		)
		const previous = Array.from({ length: 6 }, (_, position) =>
			createUserMessage(
				'\u0001'.repeat(150) +
					Array.from({ length: 60 }, (_, i) => `word${position}_${i}`)
						.join(' ')
						.slice(0, 450),
			),
		)
		await createEvidenceQueryResolver()(
			{ ...ctx, messages: [...previous, ctx.latestUserMessage!] },
			question,
		)
		const request = ctx.generateText.mock.calls[0]![0]
		const sent = JSON.parse(request.prompt)
		expect(request.system.length + request.prompt.length).toBeLessThanOrEqual(12000)
		expect(sent.tokens.length).toBeGreaterThan(0)
		expect(sent.tokens.length).toBeLessThan(256)
		expect(sent.omittedTokens).toBeGreaterThan(0)
	})
	it('does not spend a planner call when serialized history alone exceeds the allowance', async () => {
		const ctx = context()
		await createEvidenceQueryResolver()(
			{
				...ctx,
				messages: [
					...Array.from({ length: 6 }, () => createUserMessage('\u0001'.repeat(600))),
					ctx.latestUserMessage!,
				],
			},
			question,
		)
		expect(ctx.generateText).not.toHaveBeenCalled()
	})
	it.each([6, 20])(
		'keeps the preceding operator request behind %s assistant updates',
		async (updates) => {
			const ctx = context(JSON.stringify({ ...plan, mode: 'direct' }))
			await createEvidenceQueryResolver()(
				{
					...ctx,
					messages: [
						createUserMessage(
							'Inspect DELTA; report only its recorded receipt. Do not change files.',
						),
						...Array.from({ length: updates }, (_, i) => createAssistantMessage(`Progress ${i}`)),
						ctx.latestUserMessage!,
					],
				},
				question,
			)
			expect(ctx.generateText).toHaveBeenCalledOnce()
			const sent = JSON.parse(ctx.generateText.mock.calls[0]![0].prompt)
			expect(sent.history).toHaveLength(6)
			expect(sent.history[0].text).toBe(
				'Inspect DELTA; report only its recorded receipt. Do not change files.',
			)
			expect(sent.history.slice(1).map((m: { text: string }) => m.text)).toEqual(
				Array.from({ length: 5 }, (_, i) => `Progress ${updates - 5 + i}`),
			)
		},
	)
	it('does not reach outside the 64-message scan to find an earlier operator', async () => {
		const ctx = context()
		await createEvidenceQueryResolver()(
			{
				...ctx,
				messages: [
					createUserMessage('OUTSIDE_LIMIT'),
					...Array.from({ length: 64 }, () => createAssistantMessage('Progress')),
					ctx.latestUserMessage!,
				],
			},
			question,
		)
		expect(ctx.generateText).not.toHaveBeenCalled()
	})
	it('does not mistake an older equal question for a detached steering input', async () => {
		const ctx = context(JSON.stringify({ ...plan, mode: 'none' }))
		const current = createRuntimeContextMessage(question, 'steering')
		await createEvidenceQueryResolver()(
			{
				...ctx,
				latestUserMessage: current,
				messages: [
					createUserMessage('Inspect ALPHA.'),
					createUserMessage(question),
					createAssistantMessage('ALPHA finished.'),
					createUserMessage('Inspect DELTA.'),
					createAssistantMessage('Inspecting DELTA.'),
					{ role: 'tool', content: 'Observation and attached steering', toolCallId: 'observation' },
				],
			},
			question,
		)
		const sent = JSON.parse(ctx.generateText.mock.calls[0]![0].prompt)
		expect(sent.history.map((m: { text: string }) => m.text)).toContain('Inspect DELTA.')
		expect(sent.history.at(-1).text).toBe('Inspecting DELTA.')
		expect(JSON.stringify(sent)).not.toContain('Observation and attached steering')
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
		expect(retrieve.mock.calls[0]![0].terms).toEqual(wantedTerms)
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
