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
	type EvidenceRecallRequest,
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
function rendered(text: string | undefined) {
	return (text ?? '')
		.split('\n')
		.filter((line) => line.startsWith('{"runId":'))
		.map((line) => JSON.parse(line))
}
afterEach(() => vi.useRealTimers())

describe('ephemeral scoped evidence recall', () => {
	it('surfaces incomplete empty scans and host continuation calls without inventing a passage', async () => {
		const continuation = { toolName: 'search_archive', input: { cursor: 'opaque', limit: 2 } }
		const { recall } = fixture([], {
			retrieve: async () => ({ ...batch(), incomplete: true, continuations: [continuation] }),
		})
		const result = await recall(context())
		expect(result?.context).toContain('incomplete scan cannot establish absence')
		expect(result?.context).toContain(JSON.stringify(continuation))
		expect(result?.context).toContain('"omittedContinuations":0')
		expect(rendered(result?.context)).toHaveLength(0)
		expect(await fixture([]).recall(context())).toBeUndefined()
	})

	it('keeps incompleteness visible when all passages are already in history', async () => {
		const { recall } = fixture([], {
			retrieve: async () => ({ ...batch(candidate()), incomplete: true }),
		})
		const result = await recall({
			...context(),
			messages: [createUserMessage(candidate().excerpt)],
		})
		expect(result?.context).toContain('"incomplete":true')
		expect(rendered(result?.context)).toHaveLength(0)
	})

	it('budgets escaped hints after distinct text and accounts omitted continuations', async () => {
		const hints = Array.from({ length: 4 }, (_, i) => ({
			toolName: 'search_archive',
			input: { cursor: '<'.repeat(100), page: i },
		}))
		const { recall } = fixture([], {
			maxChars: 1400,
			retrieve: async () => ({ ...batch(candidate()), incomplete: true, continuations: hints }),
		})
		const result = await recall(context())
		expect(result!.context!.length).toBeLessThanOrEqual(1400)
		expect(rendered(result?.context)).toHaveLength(1)
		const meta = JSON.parse(result!.context!.split('\n')[1]!)
		expect(meta.omittedContinuations).toBeGreaterThan(0)
		expect(meta.continuations.length + meta.omittedContinuations).toBe(4)
		expect(result?.context).not.toContain('<')
	})

	it.each([
		null,
		[{ toolName: 'search archive', input: {} }],
		[{ toolName: 'search', input: { cursor: 'x'.repeat(2049) } }],
		[{ toolName: 'search', input: { value: Number.NaN } }],
		[{ toolName: 'search', input: { nested: {} } }],
		Array.from({ length: 5 }, () => ({ toolName: 'search', input: {} })),
	])('refuses malformed or oversized continuation metadata', async (continuations) => {
		const { recall } = fixture([], {
			retrieve: async () =>
				({ ...batch(), incomplete: true, continuations }) as EvidenceRecallBatch,
		})
		await expect(recall(context())).rejects.toThrow(/continuation/i)
	})

	it('rejects continuation metadata on a purportedly complete scan', async () => {
		const { recall } = fixture([], {
			retrieve: async () => ({ ...batch(), continuations: [{ toolName: 'search', input: {} }] }),
		})
		await expect(recall(context())).rejects.toThrow('invalid continuations')
	})

	it('passes the current writer with a bounded lifetime, then revokes new captures', async () => {
		let held: EvidenceRecallRequest['captureRunEvidence']
		const capture = vi.fn(async () => undefined)
		const recall = createEvidenceRecallStep({
			scope,
			retrieve: async ({ captureRunEvidence }) => {
				held = captureRunEvidence
				expect(await held!(2 * 1024 * 1024)).toBeUndefined()
				return batch()
			},
		})
		await recall({ ...context(), captureRunEvidence: capture })
		expect(capture).toHaveBeenCalledWith(2 * 1024 * 1024, expect.any(AbortSignal))
		await expect(held!()).rejects.toThrow('pass ended')
		expect(capture).toHaveBeenCalledTimes(1)
	})

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

	it('keeps a correction alongside repeated observations with every distinct source address', async () => {
		const old = 'DELTA tracking destination: OLD-471.'
		const correction =
			'DELTA tracking destination changed to NEW-892 after review. Previous receipt OLD-471 is superseded; this entry records the correction.'
		const copies = Array.from({ length: 4 }, (_, i) =>
			candidate(old, { seq: i + 1, scope: { ...scope, runId: generateRunId() } }),
		)
		const { recall } = fixture([...copies, candidate(correction, { seq: 5 })])
		const result = await recall(context('DELTA tracking destination'))
		const selected = rendered(result?.context)
		expect(selected).toHaveLength(2)
		expect(selected.map((item) => item.excerpt)).toEqual(expect.arrayContaining([old, correction]))
		const repeated = selected.find((item) => item.excerpt === old)
		expect([repeated, ...repeated.otherOccurrences].map(({ runId }) => runId)).toEqual(
			copies.map((item) => item.scope.runId),
		)
		expect(repeated.omittedOccurrences).toBe(0)
		expect(result?.context).toContain('repetition is not corroboration')
		expect(result?.context).toContain('seq orders events only within one run')
	})

	it('does not let duplicate observations change the bounded BM25 corpus statistics', async () => {
		const base = [
			candidate('DELTA depot tracking', { seq: 1 }),
			candidate('DELTA tracking tracking package receipt', { seq: 2 }),
			candidate('DELTA tracking receipt for another container in the depot', { seq: 3 }),
		]
		const query = context('DELTA tracking depot')
		const expected = rendered((await fixture(base).recall(query))?.context).map((p) => p.excerpt)
		for (const duplicate of base) {
			const copies = Array.from({ length: 20 }, (_, i) => ({ ...duplicate, seq: i + 4 }))
			const actual = await fixture([...base, ...copies]).recall(query)
			expect(rendered(actual?.context).map((p) => p.excerpt)).toEqual(expected)
		}
	})

	it('preserves small literal differences instead of inferring which version is true or current', async () => {
		const texts = ['DELTA ID: A17', 'DELTA ID: A18', 'DELTA ID: a17', 'DELTA ID: A17 ']
		const { recall } = fixture(texts.map((text, i) => candidate(text, { seq: i + 1 })))
		const selected = rendered((await recall(context('DELTA ID')))?.context)
		expect(selected.map((p) => p.excerpt)).toEqual(texts)
		expect(selected.every((p) => p.otherOccurrences === undefined)).toBe(true)
	})

	it('keeps preview, error, unknown status and different producers distinct even at equal addresses', async () => {
		const sameText = 'DELTA tracking code: A17'
		const candidates = [
			candidate(sameText),
			candidate(sameText, { isError: false }),
			candidate(sameText, { isError: true }),
			candidate(sameText, { retained: 'preview' }),
			candidate(sameText, { toolName: 'write' }),
			candidate(sameText, { source: 'message_completed', toolName: undefined }),
		]
		const selected = rendered(
			(await fixture(candidates, { maxPassages: 8 }).recall(context()))?.context,
		)
		expect(selected).toHaveLength(candidates.length)
		for (const [i, passage] of selected.entries()) {
			expect(passage).toMatchObject({
				source: candidates[i]!.source,
				retained: candidates[i]!.retained,
			})
			expect(passage.isError).toBe(candidates[i]!.isError)
			expect(passage.toolName).toBe(candidates[i]!.toolName)
			expect(passage.otherOccurrences).toBeUndefined()
		}
	})

	it('reserves text for distinct passages before adding repeated addresses and accounts omissions', async () => {
		const copies = Array.from({ length: 23 }, (_, i) =>
			candidate('DELTA tracking code: A17', { seq: i + 1 }),
		)
		const { recall } = fixture([...copies, candidate('DELTA tracking code: A18', { seq: 24 })], {
			maxChars: 1400,
		})
		const result = await recall(context())
		expect(result!.context!.length).toBeLessThanOrEqual(1400)
		const selected = rendered(result?.context)
		expect(selected).toHaveLength(2)
		const repeated = selected.find((p) => p.excerpt.endsWith('A17'))
		expect(repeated.omittedOccurrences).toBeGreaterThan(0)
		expect(repeated.otherOccurrences.length + repeated.omittedOccurrences).toBe(22)
		expect(selected[1].excerpt).toBe('DELTA tracking code: A18')
	})

	it('validates foreign duplicate text before grouping its origins', async () => {
		const { recall } = fixture([
			candidate(),
			candidate(undefined, {
				scope: { ...scope, runId: sourceRun, sessionId: generateSessionId() },
			}),
		])
		await expect(recall(context())).rejects.toThrow('different conversation')
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
