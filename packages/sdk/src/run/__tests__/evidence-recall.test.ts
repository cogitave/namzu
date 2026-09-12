import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	createAssistantMessage,
	createRuntimeContextMessage,
	createUserMessage,
} from '../../types/message/index.js'
import type { PrepareStepContext } from '../../types/run/prepare-step.js'
import {
	generateProjectId,
	generateRunId,
	generateSessionId,
	generateTenantId,
} from '../../utils/id.js'
import {
	type EvidenceRecallBatch,
	type EvidenceRecallCandidate,
	type EvidenceRecallOptions,
	createEvidenceRecallStep,
} from '../evidence-recall.js'

const scope = {
	tenantId: generateTenantId(),
	projectId: generateProjectId(),
	sessionId: generateSessionId(),
}
const sourceRun = generateRunId()
const candidate = (
	excerpt = 'DELTA tracking code: A17',
	extra: Partial<EvidenceRecallCandidate> = {},
): EvidenceRecallCandidate => ({
	scope: { ...scope, runId: sourceRun },
	seq: 2,
	part: 0,
	source: 'tool_completed',
	toolName: 'read',
	retained: 'full',
	excerpt,
	byteOffset: 1024,
	...extra,
})
function context(query = 'DELTA tracking code'): PrepareStepContext {
	return {
		runId: generateRunId(),
		stepNumber: 1,
		messages: [createUserMessage(query)],
		steps: [],
		prepared: {},
	}
}
const batch = (...candidates: EvidenceRecallCandidate[]): EvidenceRecallBatch => ({
	candidates,
	scannedBytes: 512,
	incomplete: false,
})
function fixture(candidates = [candidate()], options: Partial<EvidenceRecallOptions> = {}) {
	const retrieve = vi.fn(async () => batch(...candidates))
	return { retrieve, recall: createEvidenceRecallStep({ scope, retrieve, ...options }) }
}
afterEach(() => vi.useRealTimers())

describe('ephemeral scoped evidence recall', () => {
	it('ranks the bounded pool, keeps exact provenance, and changes only trailing context', async () => {
		const { recall } = fixture(
			[
				candidate('tracking announcement', { seq: 1 }),
				candidate('DELTA tracking code: A17 <literal>'),
				candidate('unrelated facts', { seq: 3 }),
			],
			{ maxPassages: 1 },
		)
		const ctx = { ...context(), prepared: { system: 'Stable policy', context: 'Inventory' } }
		const before = structuredClone(ctx.messages)
		const result = await recall(ctx)
		expect(result?.system).toBeUndefined()
		expect(result?.context).toContain('Inventory\n\nRetrieved conversation evidence')
		expect(result?.context).toContain('historical observations')
		expect(result?.context).toContain('A17 \\u003cliteral>')
		expect(result?.context).toContain(`"runId":"${sourceRun}"`)
		expect(result?.context).toContain('"byteOffset":1024')
		expect(result?.context).not.toContain('announcement')
		expect(ctx.messages).toEqual(before)
	})

	it('refreshes every request without caching bytes or claiming an error/preview succeeded', async () => {
		const { retrieve, recall } = fixture()
		expect((await recall(context()))?.context).toContain('A17')
		retrieve.mockResolvedValueOnce(
			batch(candidate('DELTA tracking failed', { retained: 'preview', isError: true })),
		)
		const refreshed = await recall(context())
		expect(refreshed?.context).not.toContain('A17')
		expect(refreshed?.context).toContain('"isError":true,"retained":"preview"')
		retrieve.mockResolvedValueOnce(batch())
		expect(await recall(context())).toBeUndefined()
	})

	it('uses latest operator text, ignoring generated context, and preserves literal Unicode spelling', async () => {
		const { retrieve, recall } = fixture()
		await recall({
			...context(),
			latestUserMessage: createUserMessage('İZMİR 3'),
			messages: [createUserMessage('OLD'), createRuntimeContextMessage('OTHER', 'step-context')],
		})
		expect(retrieve).toHaveBeenCalledWith(
			expect.objectContaining({
				terms: ['İZMİR', '3'],
				maxReadBytes: 8 * 1024 * 1024,
				maxCandidates: 24,
			}),
		)
		await recall({
			...context(),
			messages: [
				createUserMessage('DELTA'),
				createRuntimeContextMessage('OTHER', 'task-completion'),
			],
		})
		expect(retrieve).toHaveBeenLastCalledWith(expect.objectContaining({ terms: ['DELTA'] }))
		await recall({
			...context(),
			messages: [createUserMessage('OLD'), createRuntimeContextMessage('DELTA', 'steering')],
		})
		expect(retrieve).toHaveBeenLastCalledWith(expect.objectContaining({ terms: ['DELTA'] }))
	})

	it.each(['continue', 'devam kardeşim', ''])(
		'does not browse arbitrary history for %j',
		async (query) => {
			const { retrieve, recall } = fixture()
			expect(await recall(context(query))).toBeUndefined()
			expect(retrieve).not.toHaveBeenCalled()
		},
	)

	it('does not duplicate already visible passages or duplicate addresses', async () => {
		const a = candidate('DELTA receipt\tA17')
		const { recall } = fixture([a, a])
		const first = await recall(context())
		expect(first?.context?.split('"excerpt"')).toHaveLength(2)
		expect(
			await recall({
				...context(),
				messages: [
					createUserMessage('DELTA'),
					createAssistantMessage(JSON.stringify({ excerpt: a.excerpt })),
				],
			}),
		).toBeUndefined()
	})

	it('validates all scopes even for irrelevant/duplicate candidates and snapshots host scope', async () => {
		const owner = { ...scope }
		const { recall, retrieve } = fixture([candidate()], { scope: owner })
		owner.sessionId = generateSessionId()
		expect((await recall(context()))?.context).toContain('A17')
		for (const field of ['tenantId', 'projectId', 'sessionId'] as const) {
			retrieve.mockResolvedValueOnce(
				batch(
					candidate(),
					candidate('unrelated', {
						scope: { ...scope, runId: sourceRun, [field]: generateRunId() },
					}),
				),
			)
			await expect(recall(context())).rejects.toThrow('different conversation')
		}
	})

	it('caps the entire escaped contribution without clipping source text or counting upstream context', async () => {
		const { recall } = fixture(
			Array.from({ length: 8 }, (_, i) => candidate(`DELTA ${'"\\😀'.repeat(50)}`, { seq: i + 1 })),
			{ maxChars: 1400, maxPassages: 8 },
		)
		const result = await recall({ ...context(), prepared: { context: 'earlier' } })
		expect(result?.context?.length).toBeLessThanOrEqual(1409)
		expect(result?.context).toContain('"excerpt"')
		expect(
			await recall({ ...context(), contextBudget: { remainingTokens: 300, windowTokens: 1000 } }),
		).toBeUndefined()
	})

	it.each([
		{ candidates: [candidate('x'.repeat(513))], scannedBytes: 1, incomplete: false },
		{
			candidates: Array.from({ length: 25 }, () => candidate()),
			scannedBytes: 1,
			incomplete: false,
		},
		{ candidates: [candidate()], scannedBytes: 9 * 1024 * 1024, incomplete: false },
		{ candidates: [candidate('', { seq: -1 })], scannedBytes: 1, incomplete: false },
	])('refuses invalid bounded batches', async (invalid) => {
		await expect(
			createEvidenceRecallStep({ scope, retrieve: async () => invalid })(context()),
		).rejects.toThrow()
	})

	it('cancels timed-out reads, excludes overlaps until they settle, and never uses late bytes', async () => {
		vi.useFakeTimers()
		let settle!: (value: EvidenceRecallBatch) => void
		let readSignal: AbortSignal | undefined
		const retrieve = vi.fn(({ signal }: { signal: AbortSignal }) => {
			readSignal = signal
			return new Promise<EvidenceRecallBatch>((resolve) => {
				settle = resolve
			})
		})
		const recall = createEvidenceRecallStep({ scope, retrieve, timeoutMs: 10 })
		const first = recall(context())
		const rejected = expect(first).rejects.toThrow('timed out')
		await vi.advanceTimersByTimeAsync(11)
		await rejected
		expect(readSignal?.aborted).toBe(true)
		expect(await recall(context())).toBeUndefined()
		expect(retrieve).toHaveBeenCalledTimes(1)
		settle(batch(candidate('DELTA STALE')))
		await vi.advanceTimersByTimeAsync(0)
		retrieve.mockResolvedValueOnce(batch(candidate('DELTA FRESH')))
		expect((await recall(context()))?.context).toContain('FRESH')
	})

	it('passes parent cancellation and skips already-aborted retrieval', async () => {
		const controller = new AbortController()
		const { retrieve, recall } = fixture()
		controller.abort(new Error('operator stop'))
		await expect(recall({ ...context(), signal: controller.signal })).rejects.toThrow(
			'operator stop',
		)
		expect(retrieve).not.toHaveBeenCalled()
	})
})
