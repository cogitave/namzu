import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	createAssistantMessage,
	createRuntimeContextMessage,
	createUserMessage,
} from '../../types/message/index.js'
import type { Message } from '../../types/message/index.js'
import type { PrepareStepContext } from '../../types/session/prepare-step.js'
import {
	generateProjectId,
	generateTurnId,
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
const sourceRun = generateTurnId()
const candidate = (
	excerpt = 'DELTA tracking code: A17',
	extra: Partial<EvidenceRecallCandidate> = {},
): EvidenceRecallCandidate => ({
	scope: { ...scope, turnId: sourceRun },
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
		turnId: generateTurnId(),
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
		.filter((line) => line.startsWith('{"turnId":'))
		.map((line) => JSON.parse(line))
}
afterEach(() => vi.useRealTimers())

describe('ephemeral scoped evidence recall', () => {
	it('keeps whole, partial and unknown excerpts distinct at the same address', async () => {
		const text = 'DELTA tracking code A17'
		const entries = [true, false, undefined].map((excerptComplete) =>
			candidate(text, { byteOffset: 0, excerptComplete }),
		)
		const { recall } = fixture(entries)
		const result = await recall(context())
		expect(rendered(result?.context).map((p) => p.excerptComplete)).toEqual([
			true,
			false,
			undefined,
		])
		expect(rendered(result?.context).every((p) => p.otherOccurrences === undefined)).toBe(true)
		expect(result?.context).toContain(
			'Completeness does not prove source claims or exhaust history',
		)
		const visible = await recall({
			...context(),
			messages: [createUserMessage('DELTA'), createAssistantMessage(text)],
		})
		expect(rendered(visible?.context)).toHaveLength(0)
		expect(
			JSON.parse(visible!.context!.split('\n')[1]!).visibleEvidence.map(
				(p: { excerptComplete?: boolean }) => p.excerptComplete,
			),
		).toEqual([true, false, undefined])
	})

	it.each([
		{ excerptComplete: 'true' },
		{ excerptComplete: true, retained: 'preview' },
		{ excerptComplete: true, byteOffset: 1 },
	])('refuses inconsistent whole-excerpt claims before selection: %j', async (invalid) => {
		const entry = candidate('unrelated', {
			byteOffset: 0,
			...invalid,
		} as Partial<EvidenceRecallCandidate>)
		await expect(fixture([candidate(), entry]).recall(context())).rejects.toThrow('invalid passage')
	})

	it('counts coverage metadata inside the shared context allowance', async () => {
		const entries = Array.from({ length: 10 }, (_, i) =>
			candidate(`DELTA receipt ${i}`, { seq: i + 2, byteOffset: 0, excerptComplete: true }),
		)
		const result = await fixture(entries, { maxChars: 1400 }).recall(context())
		expect(result!.context!.length).toBeLessThanOrEqual(1400)
		expect(rendered(result?.context).length).toBeGreaterThan(0)
		expect(JSON.parse(result!.context!.split('\n')[1]!).omittedPassages).toBeGreaterThan(0)
	})

	it('keeps an original tool record alongside repeated model claims without deciding which is true', async () => {
		const claims = Array.from({ length: 4 }, (_, i) =>
			candidate(`DELTA tracking code CLAIMED; report ${i}.`, {
				seq: i + 2,
				source: i % 2 ? 'compaction_shed:assistant' : 'message_completed',
				toolName: undefined,
			}),
		)
		const original = candidate(`DELTA OBSERVED ${'accompanying notes '.repeat(16)}`, { seq: 7 })
		const input = [...claims, original]
		const before = structuredClone(input)
		const result = await fixture(input).recall(context())
		const selected = rendered(result?.context)
		expect(selected.map((p) => p.seq)).toEqual([2, 7, 3, 4])
		expect(selected[0].recordKind).toBe('assistant_message')
		expect(selected[1].recordKind).toBe('tool_result')
		expect(selected[1].excerpt).toBe(original.excerpt)
		expect(result?.context).toContain('not proof of observed state or successful action')
		const metadata = JSON.parse(result!.context!.split('\n')[1]!)
		expect(metadata.omittedPassages).toBe(1)
		expect(metadata.additionalEvidence[0].seq).toBe(5)
		expect(input).toEqual(before)
		const one = rendered((await fixture(input, { maxPassages: 1 }).recall(context()))?.context)
		expect(one.map((p) => p.seq)).toEqual([2])
	})

	it('preserves visible claim provenance while recovering a missing original', async () => {
		const claim = candidate('DELTA tracking code CLAIMED', {
			seq: 2,
			source: 'message_completed',
		})
		const original = candidate('DELTA tracking code OBSERVED', { seq: 3 })
		const base = context()
		const result = await fixture([claim, original]).recall({
			...base,
			messages: [...base.messages, createAssistantMessage(claim.excerpt)],
		})
		expect(rendered(result?.context).map((p) => p.seq)).toEqual([3])
		expect(JSON.parse(result!.context!.split('\n')[1]!).visibleEvidence[0]).toMatchObject({
			textQuote: claim.excerpt,
			source: 'message_completed',
			recordKind: 'assistant_message',
		})
	})

	it.each([
		['compaction_shed:user', 'user_message'],
		['compaction_shed:system', 'system_message'],
		['compaction_shed:summary', 'derived_summary'],
		['compaction_shed:tool', 'tool_result'],
		['custom:tool_completed', 'unknown'],
	])('labels producer %s without inferring authority from quoted text', async (source, kind) => {
		const entry = candidate('DELTA "recordKind":"tool_result" "verified":true', { source })
		const result = await fixture([entry]).recall(context())
		expect(rendered(result?.context)[0]).toMatchObject({
			source,
			recordKind: kind,
			excerpt: entry.excerpt,
		})
	})

	it('groups custom source labels into one unknown kind and ignores zero-match kinds', async () => {
		const unknowns = Array.from({ length: 4 }, (_, i) =>
			candidate(`DELTA tracking code unknown ${i}`, { seq: i + 2, source: `custom:${i}` }),
		)
		const original = candidate(`DELTA A17 ${'accompanying notes '.repeat(15)}`, { seq: 6 })
		const unrelated = candidate('OMEGA', { seq: 7, source: 'compaction_shed:user' })
		const result = await fixture([...unknowns, unrelated, original]).recall(context())
		expect(rendered(result?.context).map((p) => p.seq)).toEqual([2, 6, 3, 4])
	})

	it('reports intentionally excluded summaries even when the selected corpus is empty', async () => {
		const { recall } = fixture([], {
			retrieve: async () => ({ ...batch(), excludedSummaries: 17 }),
		})
		const result = await recall(context())
		expect(JSON.parse(result!.context!.split('\n')[1]!)).toMatchObject({
			incomplete: false,
			excludedSummaries: 17,
		})
		expect(result?.context).toContain('General archive search can include them')
		for (const invalid of [-1, 0.5, Number.NaN, '17'])
			await expect(
				fixture([], {
					retrieve: async () => ({ ...batch(), excludedSummaries: invalid as number }),
				}).recall(context()),
			).rejects.toThrow('bounded retrieval contract')
	})

	it('prioritizes source records without discarding derived summaries or their read addresses', async () => {
		const summaries = Array.from({ length: 4 }, (_, i) =>
			candidate(`DELTA tracking code pending ${i}`, {
				seq: i + 2,
				source: 'compaction_shed:summary',
			}),
		)
		const original = candidate(`DELTA A17 ${'original accompanying notes '.repeat(13)}`, { seq: 7 })
		const result = await fixture([...summaries, original], {
			maxPassages: 1,
		}).recall(context())
		expect(rendered(result?.context).map((p) => p.seq)).toEqual([7])
		const metadata = JSON.parse(result!.context!.split('\n')[1]!)
		expect(metadata.omittedPassages).toBe(4)
		expect(metadata.additionalEvidence.map((p: { seq: number }) => p.seq)).toEqual([2, 3, 4, 5])
		expect(result!.context!.length).toBeLessThanOrEqual(6000)
		const onlySummaries = await fixture(summaries, { maxPassages: 1 }).recall(context())
		expect(rendered(onlySummaries?.context)[0]).toMatchObject({
			source: 'compaction_shed:summary',
			seq: 2,
		})
		expect(onlySummaries?.context).toContain('derived text, not an independent observation')
	})

	it('checks a derived candidate owner even when source prioritization would omit it', async () => {
		const derived = candidate('DELTA pending', {
			source: 'compaction_shed:summary',
		})
		await expect(
			fixture(
				[
					candidate('DELTA A17'),
					{
						...derived,
						scope: { ...derived.scope, sessionId: generateSessionId() },
					},
				],
				{ maxPassages: 1 },
			).recall(context()),
		).rejects.toThrow('different conversation scope')
	})

	it.each(['string', 'blocks', 'context', 'system'] as const)(
		'prioritizes missing evidence over text already visible in %s',
		async (shape) => {
			const already = 'DELTA tracking code pending'
			const missing = `DELTA tracking code A17; ${'accompanying notes '.repeat(20)}`
			const entries = [candidate(already), candidate(missing, { seq: 3 })]
			const base = context()
			const ctx: PrepareStepContext =
				shape === 'context' || shape === 'system'
					? { ...base, prepared: { [shape]: already } }
					: {
							...base,
							messages: [
								...base.messages,
								{
									role: 'tool',
									toolCallId: 'visible',
									content:
										shape === 'string'
											? already
											: [
													{ type: 'image', data: 'binary', mediaType: 'image/png' },
													{ type: 'text', text: already },
												],
								},
							],
						}
			const before = structuredClone(ctx)
			const result = await fixture(entries, { maxPassages: 1 }).recall(ctx)
			const recalled = result?.context?.slice(shape === 'context' ? already.length + 2 : 0)
			expect(rendered(recalled).map((p) => p.seq)).toEqual([3])
			const metadata = JSON.parse(recalled!.split('\n')[1]!)
			expect(metadata.omittedVisibleEvidence).toBe(1)
			expect(metadata.omittedPassages).toBe(0)
			expect(recalled!.length).toBeLessThanOrEqual(6000)
			if (shape === 'context') expect(result?.context?.startsWith(`${already}\n\n`)).toBe(true)
			expect(ctx).toEqual(before)
		},
	)

	it('keeps rich text block boundaries, excludes binary metadata and private reasoning from visibility', async () => {
		const excerpt = 'DELTA A17'
		const history: Message[] = [
			{
				role: 'tool',
				toolCallId: 'split',
				content: [
					{ type: 'text', text: 'DELTA ' },
					{ type: 'text', text: 'A17' },
					{ type: 'image', data: excerpt, mediaType: excerpt },
					{ type: 'document', data: excerpt, name: excerpt, mediaType: excerpt },
				],
			},
			{
				role: 'assistant',
				content: null,
				reasoning: [{ type: 'thinking', text: excerpt, signature: 'private' }],
			},
		]
		const result = await fixture([candidate(excerpt)]).recall({
			...context(),
			latestUserMessage: createUserMessage('DELTA tracking code'),
			messages: history,
		})
		expect(rendered(result?.context).map((p) => p.excerpt)).toEqual([excerpt])
		expect(result?.context).not.toContain('visibleEvidence')
	})

	it('revalidates rich visible quotes instead of treating them as an authorization cache', async () => {
		const entry = candidate()
		const { recall } = fixture([
			entry,
			{ ...entry, scope: { ...entry.scope, sessionId: generateSessionId() } },
		])
		await expect(
			recall({
				...context(),
				latestUserMessage: createUserMessage('DELTA tracking code'),
				messages: [
					{ role: 'tool', toolCallId: 'visible', content: [{ type: 'text', text: entry.excerpt }] },
				],
			}),
		).rejects.toThrow('different conversation scope')
	})

	it('reports deliberate source exclusions even when no passage is selected', async () => {
		const recall = createEvidenceRecallStep({
			scope,
			retrieve: async () => ({ ...batch(), excludedToolResults: 12 }),
		})
		const result = await recall(context())
		expect(result?.context).toContain('"excludedToolResults":12')
		expect(result?.context).toContain('Explicit archive search may include them')
		expect(result?.context).toContain('"incomplete":false')
		expect(result!.context!.length).toBeLessThanOrEqual(6000)
	})

	it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
		'rejects invalid exclusion counts (%s)',
		async (excludedToolResults) => {
			const recall = createEvidenceRecallStep({
				scope,
				retrieve: async () => ({ ...batch(), excludedToolResults }),
			})
			await expect(recall(context())).rejects.toThrow('bounded retrieval contract')
		},
	)
	it('binds visible quotes to source metadata while preserving status and original history', async () => {
		const text = 'DELTA receipt "SAME" <untrusted>'
		const entries = [
			candidate(text, { recordedAt: 1000, seq: 2, isError: false }),
			candidate(text, { recordedAt: 2000, seq: 3, isError: true, retained: 'preview' }),
			candidate(text, { seq: 4, source: 'compaction_shed:tool' }),
		]
		const ctx = { ...context('DELTA receipt'), messages: [createUserMessage(text)] }
		const before = structuredClone(ctx.messages)
		const result = await fixture(entries).recall(ctx)
		expect(ctx.messages).toEqual(before)
		expect(result?.context).not.toContain('<untrusted>')
		expect(rendered(result?.context)).toHaveLength(0)
		const metadata = JSON.parse(result!.context!.split('\n')[1]!)
		expect(metadata.visibleEvidence.map((e: { recordedAt?: number }) => e.recordedAt)).toEqual([
			1000,
			2000,
			undefined,
		])
		expect(metadata.visibleEvidence.every((e: { textQuote: string }) => e.textQuote === text)).toBe(
			true,
		)
		expect(metadata.visibleEvidence[1]).toMatchObject({ isError: true, retained: 'preview' })
		expect(metadata.visibleEvidence[2]).toMatchObject({ source: 'compaction_shed:tool' })
		expect(metadata.incomplete).toBe(false)
		expect(metadata.omittedPassages).toBe(0)
	})

	it('counts visible source omissions within the same character budget', async () => {
		const entries = Array.from({ length: 24 }, (_, i) => candidate('DELTA visible', { seq: i + 1 }))
		const result = await fixture(entries, { maxChars: 1400 }).recall({
			...context('DELTA'),
			messages: [createAssistantMessage('DELTA visible')],
			latestUserMessage: createUserMessage('DELTA'),
		})
		expect(result!.context!.length).toBeLessThanOrEqual(1400)
		const metadata = JSON.parse(result!.context!.split('\n')[1]!)
		expect(metadata.omittedVisibleEvidence).toBeGreaterThan(0)
		expect(metadata.visibleEvidence.length + metadata.omittedVisibleEvidence).toBe(24)
		expect(
			metadata.visibleEvidence.every((e: { textQuote: string }) => e.textQuote === 'DELTA visible'),
		).toBe(true)
		expect(rendered(result?.context)).toHaveLength(0)
	})

	it('keeps new-text ranking independent of visible duplicates and omits irrelevant references', async () => {
		const novel = [
			candidate('DELTA tracking ORIGINAL', { seq: 2 }),
			candidate('DELTA OTHER', { seq: 3 }),
		]
		const copies = Array.from({ length: 8 }, (_, i) =>
			candidate('DELTA tracking visible', { seq: i + 4 }),
		)
		const irrelevant = candidate('not relevant', { seq: 20 })
		const ctx = {
			...context(),
			messages: [createAssistantMessage('DELTA tracking visible; not relevant')],
			latestUserMessage: createUserMessage('DELTA tracking code'),
		}
		const baseline = await fixture(novel, { maxPassages: 1 }).recall(ctx)
		const result = await fixture([...novel, ...copies, irrelevant], { maxPassages: 1 }).recall(ctx)
		expect(rendered(result?.context).map((p) => p.excerpt)).toEqual(
			rendered(baseline?.context).map((p) => p.excerpt),
		)
		const metadata = JSON.parse(result!.context!.split('\n')[1]!)
		expect(metadata.visibleEvidence).toHaveLength(0)
		expect(metadata.omittedVisibleEvidence).toBe(8)
	})

	it('allocates one source per distinct visible quote before extra copies', async () => {
		const old = 'DELTA '.repeat(50) + 'OLD'
		const correction = 'DELTA '.repeat(50) + 'CORRECTED'
		const copies = Array.from({ length: 12 }, (_, i) => candidate(old, { seq: i + 1 }))
		const result = await fixture([...copies, candidate(correction, { seq: 20 })], {
			maxChars: 2300,
		}).recall({
			...context(),
			latestUserMessage: createUserMessage('DELTA'),
			messages: [createAssistantMessage(`${old}\n${correction}`)],
		})
		const metadata = JSON.parse(result!.context!.split('\n')[1]!)
		expect(result!.context!.length).toBeLessThanOrEqual(2300)
		expect(
			metadata.visibleEvidence.slice(0, 2).map((e: { textQuote: string }) => e.textQuote),
		).toEqual([old, correction])
		expect(metadata.omittedVisibleEvidence).toBeGreaterThan(0)
	})

	it('preserves recording times of equal observations without treating them as separate votes', async () => {
		const first = Date.UTC(2025, 1, 1)
		const second = Date.UTC(2026, 1, 1)
		const { recall } = fixture([
			candidate(undefined, { recordedAt: first }),
			candidate(undefined, { seq: 3, recordedAt: second }),
		])
		const result = await recall(context())
		const entries = rendered(result?.context)
		expect(entries).toHaveLength(1)
		expect(entries[0].recordedAt).toBe(first)
		expect(entries[0].otherOccurrences[0].recordedAt).toBe(second)
		expect(result?.context).toContain('not fact time')
	})

	it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 8_640_000_000_000_001])(
		'rejects invalid callback recording time (%s)',
		async (recordedAt) => {
			const { recall } = fixture([candidate(undefined, { recordedAt })])
			await expect(recall(context())).rejects.toThrow('invalid passage')
		},
	)

	it('discloses withheld distinct passages even when candidate traversal completed', async () => {
		const entries = Array.from({ length: 5 }, (_, i) =>
			candidate(`DELTA receipt code V${i}`, { seq: i + 2 }),
		)
		const { recall } = fixture(entries)
		const result = await recall(context('DELTA receipt code'))
		const meta = JSON.parse(result!.context!.split('\n')[1]!)
		expect(meta).toMatchObject({ incomplete: false, omittedPassages: 1, omittedAddresses: 0 })
		expect(rendered(result?.context)).toHaveLength(4)
		expect(meta.additionalEvidence).toEqual([
			{ turnId: sourceRun, seq: 6, part: 0, byteOffset: 1024 },
		])
		expect(meta.continuations).toBeUndefined()
	})

	it('keeps addresses and omission counts when no whole excerpt fits', async () => {
		const { recall } = fixture([candidate(`DELTA ${'x'.repeat(490)}`)], { maxChars: 1150 })
		const result = await recall(context())
		expect(rendered(result?.context)).toHaveLength(0)
		expect(result!.context!.length).toBeLessThanOrEqual(1150)
		const meta = JSON.parse(result!.context!.split('\n')[1]!)
		expect(meta).toMatchObject({ incomplete: false, omittedPassages: 1, omittedAddresses: 0 })
		expect(meta.additionalEvidence).toHaveLength(1)
	})

	it('counts eligible groups only, excluding visible text, exact copies and zero-score matches', async () => {
		const entries = [
			candidate(),
			candidate(),
			candidate('unrelated'),
			candidate('DELTA other', { seq: 3 }),
		]
		const { recall } = fixture(entries)
		const ctx = context('DELTA')
		const result = await recall({
			...ctx,
			messages: [...ctx.messages, createAssistantMessage('DELTA other')],
		})
		expect(JSON.parse(result!.context!.split('\n')[1]!)).toMatchObject({ omittedPassages: 0 })
		expect(rendered(result?.context)).toHaveLength(1)
	})

	it('counts addresses that cannot fit without silently raising the character limit', async () => {
		const entries = Array.from({ length: 24 }, (_, i) => candidate(`DELTA ${i}`, { seq: i + 2 }))
		const { recall } = fixture(entries, { maxChars: 1150, maxPassages: 1 })
		const result = await recall(context())
		expect(result!.context!.length).toBeLessThanOrEqual(1150)
		const meta = JSON.parse(result!.context!.split('\n')[1]!)
		expect(meta.omittedPassages).toBe(23)
		expect(meta.omittedAddresses).toBeGreaterThan(0)
		expect(meta.additionalEvidence.length + meta.omittedAddresses).toBe(23)
	})

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
		let held: EvidenceRecallRequest['captureSessionEvidence']
		const capture = vi.fn(async () => undefined)
		const recall = createEvidenceRecallStep({
			scope,
			retrieve: async ({ captureSessionEvidence }) => {
				held = captureSessionEvidence
				expect(await held!(2 * 1024 * 1024)).toBeUndefined()
				return batch()
			},
		})
		await recall({ ...context(), captureSessionEvidence: capture })
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
		expect(result?.context).toContain('historical records')
		expect(result?.context).toContain('A17 \\u003cliteral>')
		expect(result?.context).toContain(`"turnId":"${sourceRun}"`)
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

	it('uses one quoted source reference for an already visible passage', async () => {
		const a = candidate('DELTA receipt\tA17')
		const { recall } = fixture([a, a])
		const first = await recall(context())
		expect(first?.context?.split('"excerpt"')).toHaveLength(2)
		const visible = await recall({
			...context(),
			messages: [
				createUserMessage('DELTA'),
				createAssistantMessage(JSON.stringify({ excerpt: a.excerpt })),
			],
		})
		expect(rendered(visible?.context)).toHaveLength(0)
		expect(visible?.context).not.toContain('"excerpt"')
		const metadata = JSON.parse(visible!.context!.split('\n')[1]!)
		expect(metadata.visibleEvidence).toHaveLength(1)
		expect(metadata.visibleEvidence[0].textQuote).toBe(a.excerpt)
		expect(metadata.visibleEvidence[0].address).toEqual({
			turnId: sourceRun,
			seq: 2,
			part: 0,
			byteOffset: 1024,
		})
		expect(metadata.visibleEvidence[0].recordedAt).toBeUndefined()
		expect(metadata.omittedVisibleEvidence).toBe(0)
	})

	it('keeps a correction alongside repeated observations with every distinct source address', async () => {
		const old = 'DELTA tracking destination: OLD-471.'
		const correction =
			'DELTA tracking destination changed to NEW-892 after review. Previous receipt OLD-471 is superseded; this entry records the correction.'
		const copies = Array.from({ length: 4 }, (_, i) =>
			candidate(old, { seq: i + 1, scope: { ...scope, turnId: generateTurnId() } }),
		)
		const { recall } = fixture([...copies, candidate(correction, { seq: 5 })])
		const result = await recall(context('DELTA tracking destination'))
		const selected = rendered(result?.context)
		expect(selected).toHaveLength(2)
		expect(selected.map((item) => item.excerpt)).toEqual(expect.arrayContaining([old, correction]))
		const repeated = selected.find((item) => item.excerpt === old)
		expect([repeated, ...repeated.otherOccurrences].map(({ turnId }) => turnId)).toEqual(
			copies.map((item) => item.scope.turnId),
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
		for (const entry of candidates) {
			const matches = selected.filter(
				(passage) =>
					passage.source === entry.source &&
					passage.retained === entry.retained &&
					passage.isError === entry.isError &&
					passage.toolName === entry.toolName,
			)
			expect(matches).toHaveLength(1)
			expect(matches[0].otherOccurrences).toBeUndefined()
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
				scope: { ...scope, turnId: sourceRun, sessionId: generateSessionId() },
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
						scope: { ...scope, turnId: sourceRun, [field]: generateTurnId() },
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
		expect((await recall(context()))?.context).toContain('"reason":"pending"')
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

it('does not attach a failure note to parent cancellation during retrieval', async () => {
	const controller = new AbortController()
	const stopped = new Error('operator stop')
	const recall = createEvidenceRecallStep({
		scope,
		retrieve: async () => {
			controller.abort(stopped)
			return batch(candidate('DELTA LATE_PRIVATE_DATA'))
		},
	})
	await expect(recall({ ...context(), signal: controller.signal })).rejects.toBe(stopped)
	expect(stopped).not.toHaveProperty('context')
})
