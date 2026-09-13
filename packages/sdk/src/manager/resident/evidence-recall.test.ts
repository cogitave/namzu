import { afterEach, expect, it, vi } from 'vitest'
import type { PrepareStepContext } from '../../types/run/prepare-step.js'
import {
	generateProjectId,
	generateRunId,
	generateSessionId,
	generateTenantId,
} from '../../utils/id.js'
import { createResidentEvidenceRecallStep } from './evidence-recall.js'
import type { ResidentState } from './store.js'
import type {
	ResidentToolEvidenceSearchResult,
	ResidentToolEvidenceSource,
} from './tool-evidence.js'

afterEach(() => vi.useRealTimers())
function fixture() {
	const owner = {
		tenantId: generateTenantId(),
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		runId: generateRunId(),
	}
	const pursuitId = generateRunId()
	const state: ResidentState = {
		tenantId: owner.tenantId,
		agentKey: 'reviewer',
		pursuitId,
		claimId: generateRunId(),
		identity: 'Inspector',
		objective: 'DELTA receipt',
		revision: 5,
		stepsAdmitted: 2,
		phase: 'running',
		wakeAt: null,
		reason: 'Accepted wake.',
		summary: 'ALPHA old claim.',
		wakeEvidence: [
			{ reason: 'BRAVO earlier input.', receivedAt: 1 },
			{ reason: 'CHARLIE correction.', receivedAt: 2 },
		],
	}
	const scope = {
		tenantId: owner.tenantId,
		projectId: owner.projectId,
		agentKey: state.agentKey,
		pursuitId,
		throughRevision: 8,
	}
	const original = { ...owner, sessionId: generateSessionId(), runId: generateRunId() }
	const page: ResidentToolEvidenceSearchResult = {
		scope,
		revision: 4,
		claimId: generateRunId(),
		nextCursor: null,
		incomplete: false,
		unavailableRevisions: [],
		historyBytes: 10,
		chargedBytes: 200,
		evidence: {
			scope: original,
			matches: [
				{
					address: 'opaque:original',
					seq: 3,
					toolName: 'read',
					isError: false,
					retained: 'full',
					excerpt: 'DELTA original: A-73',
					excerptComplete: true,
					byteOffset: 0,
				},
			],
			nextCursor: null,
			scannedBytes: 100,
			indexedRecords: 1,
			cacheHit: true,
			incomplete: false,
			unavailable: [],
		},
	}
	const search = vi.fn(async () => page)
	const source: ResidentToolEvidenceSource = { scope, search, read: vi.fn() }
	const context: PrepareStepContext = {
		runId: owner.runId,
		stepNumber: 1,
		messages: [],
		steps: [],
		prepared: { context: 'Earlier preparation.' },
	}
	return {
		owner,
		state,
		scope,
		source,
		search,
		page,
		original,
		context,
		create: (extra = {}) =>
			createResidentEvidenceRecallStep({ source, state, scope: owner, ...extra }),
	}
}
function records(text = '') {
	return text
		.split('\n')
		.filter((line) => line.startsWith('{'))
		.map((line) => JSON.parse(line))
}

it('uses objective, committed wakes and derived summary words without forging a conversation session', async () => {
	const f = fixture()
	const before = JSON.stringify(f.context)
	const result = await f.create()(f.context)
	const request = f.search.mock.calls[0] as unknown as [{ terms: string[] }]
	expect(request[0].terms).toEqual(expect.arrayContaining(['DELTA', 'ALPHA', 'BRAVO', 'CHARLIE']))
	const [metadata, passage] = records(result?.context)
	expect(metadata.querySelection.terms).toContainEqual({ term: 'ALPHA', source: 'derived_summary' })
	expect(metadata.querySelection.terms).toContainEqual({
		term: 'CHARLIE',
		source: 'accepted_wake',
		wakeIndex: 1,
	})
	expect(passage).toMatchObject({
		sessionId: f.original.sessionId,
		runId: f.original.runId,
		revision: 4,
		claimId: f.page.claimId,
		address: 'opaque:original',
		byteOffset: 0,
		excerpt: 'DELTA original: A-73',
		recordKind: 'tool_result',
	})
	expect(passage).not.toHaveProperty('part')
	expect(result?.context).toContain('Retrieved resident evidence')
	expect(result?.context).toContain('Earlier preparation.')
	expect(JSON.stringify(f.context)).toBe(before)
	expect(f.source.read).not.toHaveBeenCalled()
})

it('recalls again on every iteration; newer observed corrections remain distinct', async () => {
	const f = fixture()
	const recall = f.create()
	await recall(f.context)
	const original = f.page.evidence
	const firstMatch = original?.matches[0]
	if (!original || !firstMatch) throw new Error('Missing fixture evidence.')
	const newer = {
		...firstMatch,
		excerpt: 'DELTA corrected: B-91',
		address: 'opaque:correction',
		seq: 4,
	}
	f.search.mockResolvedValue({
		...f.page,
		evidence: { ...original, matches: [...original.matches, newer] },
	})
	const result = await recall({ ...f.context, stepNumber: 2 })
	expect(f.search).toHaveBeenCalledTimes(2)
	expect(result?.context).toContain('A-73')
	expect(result?.context).toContain('B-91')
	expect(result?.context).toContain('opaque:correction')
})

it.each(['tenantId', 'projectId', 'agentKey', 'pursuitId', 'throughRevision'] as const)(
	'rejects a returned page outside captured %s',
	async (field) => {
		const f = fixture()
		f.search.mockResolvedValue({
			...f.page,
			scope: { ...f.scope, [field]: field === 'throughRevision' ? 9 : generateRunId() },
		})
		await expect(f.create()(f.context)).rejects.toThrow()
	},
)

it('refuses another executor and never advances a mutated source boundary', async () => {
	const f = fixture()
	const recall = f.create()
	await expect(recall({ ...f.context, runId: generateRunId() })).rejects.toThrow('different run')
	f.scope.throughRevision++
	await expect(recall(f.context)).rejects.toThrow('boundary')
	expect(f.search).not.toHaveBeenCalled()
})

it.each([
	'project',
	'current_run',
	'current_claim',
	'future_revision',
	'invalid_bytes',
	'invalid_passage',
])('discards the whole automatic batch on %s', async (fault) => {
	const f = fixture()
	if (!f.page.evidence) throw new Error('Missing fixture evidence.')
	const page = {
		...structuredClone(f.page),
		evidence: {
			...f.page.evidence,
			matches: [...f.page.evidence.matches],
			scope: { ...f.original },
		},
	}
	if (fault === 'project') page.evidence.scope.projectId = generateProjectId()
	if (fault === 'current_run') page.evidence.scope.runId = f.owner.runId
	if (fault === 'current_claim') page.claimId = f.state.claimId
	if (fault === 'future_revision') page.revision = 9
	if (fault === 'invalid_bytes') page.chargedBytes = 8 * 1024 * 1024 + 1
	if (fault === 'invalid_passage' && page.evidence.matches[0])
		page.evidence.matches.push({ ...page.evidence.matches[0], seq: -1, excerpt: 'FOREIGN-SECRET' })
	f.search.mockResolvedValue(page)
	try {
		await f.create()(f.context)
		throw new Error('Expected rejection.')
	} catch (error) {
		expect(error).not.toHaveProperty('message', 'Expected rejection.')
		expect(JSON.stringify(error)).not.toContain('FOREIGN-SECRET')
	}
})

it('caps traversal at four pages, accounts bytes together and supplies the original continuation', async () => {
	const f = fixture()
	f.search.mockImplementation(async () => ({
		...f.page,
		evidence: null,
		nextCursor: `cursor-${f.search.mock.calls.length}`,
		incomplete: true,
		chargedBytes: 1000,
	}))
	const result = await f.create()(f.context)
	expect(f.search).toHaveBeenCalledTimes(4)
	const calls = f.search.mock.calls as unknown as [
		{ cursor?: string; terms?: string[]; maxReadBytes: number },
	][]
	expect(calls[1]?.[0]).toEqual({ cursor: 'cursor-1', maxReadBytes: 8 * 1024 * 1024 - 1000 })
	const [metadata] = records(result?.context)
	expect(metadata).toMatchObject({
		scannedBytes: 4000,
		incomplete: true,
		continuations: [{ toolName: 'search_resident_tools', input: { cursor: 'cursor-4' } }],
	})
})

it('does no I/O without framing room and bounds selected terms even for long accepted input', async () => {
	const f = fixture()
	const recall = f.create()
	expect(
		await recall({ ...f.context, contextBudget: { remainingTokens: 100, windowTokens: 1000 } }),
	).toBeUndefined()
	expect(f.search).not.toHaveBeenCalled()
	const long = f.create({
		state: {
			...f.state,
			objective: `${'word '.repeat(1000)}DELTA`,
			summary: `${'long '.repeat(1000)}ALPHA`,
		},
		maxChars: 2800,
	})
	const result = await long(f.context)
	expect(
		(result?.context?.length ?? 0) - (f.context.prepared.context?.length ?? 0),
	).toBeLessThanOrEqual(2802)
})

it('keeps explicit incompleteness when a backend has no continuation', async () => {
	const f = fixture()
	f.search.mockResolvedValue({ ...f.page, evidence: null, incomplete: true })
	expect(records((await f.create()(f.context))?.context)[0]?.incomplete).toBe(true)
})

it.each(['objective', 'summary', 'wake'] as const)(
	'finds the subject at both ends of a long %s without minting boundary fragments',
	async (field) => {
		const f = fixture()
		const text = `Kestrel ${'x'.repeat(4200)} Borealis`
		const state = {
			...f.state,
			objective: 'Review receipts',
			summary: null,
			wakeEvidence: undefined,
		}
		const selectedState = {
			...state,
			...(field === 'wake'
				? { wakeEvidence: [{ reason: text, receivedAt: 1 }] }
				: { [field]: text }),
		}
		await f.create({ state: selectedState })(f.context)
		const terms = (f.search.mock.calls[0] as unknown as [{ terms: string[] }])[0].terms
		expect(terms).toEqual(expect.arrayContaining(['Kestrel', 'Borealis']))
		expect(terms.some((term) => term.includes('x'))).toBe(false)
		expect(terms.length).toBeLessThanOrEqual(16)
	},
)

it('gives a late accepted correction a term slot even in a short but wordy input', async () => {
	const f = fixture()
	await f.create({
		state: {
			...f.state,
			wakeEvidence: [
				{
					reason:
						'Operations reviewed delivery progress across regions and checked outstanding paperwork before the final review. Correct Borealis.',
					receivedAt: 3,
				},
			],
		},
	})(f.context)
	const terms = (f.search.mock.calls[0] as unknown as [{ terms: string[] }])[0].terms
	expect(terms).toContain('Borealis')
})

it('does not turn an astral letter cut at a field boundary into a new search word', async () => {
	const f = fixture()
	const objective = `${' '.repeat(1995)}LEFT𝔸${' '.repeat(1000)}𝔸RIGHT${' '.repeat(1994)}END`
	// Keep non-whitespace at the ends because admitted text is trimmed.
	const text = `K${objective.slice(1, -4)}Z`
	await f.create({ state: { ...f.state, objective: text } })(f.context)
	const terms = (f.search.mock.calls[0] as unknown as [{ terms: string[] }])[0].terms
	expect(terms).not.toContain('LEFT')
	expect(terms).not.toContain('RIGHT')
})

it('does not advertise a focused cursor before the remaining read budget admits that scan', async () => {
	const f = fixture()
	const evidence = f.page.evidence
	const match = evidence?.matches[0]
	if (!evidence || !match) throw new Error('Missing original.')
	f.search.mockResolvedValue({
		...f.page,
		nextCursor: 'broad-only',
		incomplete: true,
		chargedBytes: 7 * 1024 * 1024,
		evidence: {
			...evidence,
			matches: Array.from({ length: 4 }, (_, i) => ({
				...match,
				seq: i + 1,
				excerpt: 'Atlas inspected',
			})),
		},
	})
	const result = await f.create({
		source: { ...f.source, supportsTermRefinement: true },
		state: { ...f.state, objective: 'Atlas Borealis', summary: null, wakeEvidence: undefined },
	})(f.context)
	expect(f.search).toHaveBeenCalledTimes(1)
	expect(records(result?.context)[0]).toMatchObject({
		incomplete: true,
		continuations: [{ toolName: 'search_resident_tools', input: { cursor: 'broad-only' } }],
	})
})

it('spends the shared pages on uncovered subjects, then resumes the original cursor', async () => {
	const f = fixture()
	if (!f.page.evidence) throw new Error('Missing evidence.')
	const evidence = f.page.evidence
	const original = evidence.matches[0]
	if (!original) throw new Error('Missing original.')
	const calls: {
		terms?: string[]
		cursor?: string
		maxReadBytes: number
		excludeSuccessfulTools?: string[]
	}[] = []
	f.search.mockImplementation(async (...args) => {
		const options = (args as unknown as [(typeof calls)[number]])[0]
		calls.push(options)
		const focused = options.terms?.length === 1 && options.terms[0] === 'Borealis'
		return {
			...f.page,
			chargedBytes: 1000,
			nextCursor: focused ? null : `broad-${calls.length}`,
			incomplete: !focused,
			evidence: {
				...evidence,
				matches: Array.from({ length: focused ? 1 : 4 }, (_, index) => ({
					...original,
					seq: calls.length * 4 + index,
					address: `source-${calls.length}-${index}`,
					excerpt: focused ? 'Borealis TRACK_739' : `Atlas inspected region ${calls.length}`,
				})),
			},
		}
	})
	const result = await f.create({
		state: { ...f.state, objective: 'Atlas Borealis', summary: 'Atlas', wakeEvidence: undefined },
		excludeSuccessfulTools: ['search_resident_tools'],
		maxChars: 12000,
	})(f.context)
	expect(result?.context).toContain('TRACK_739')
	expect(calls).toHaveLength(4)
	expect(calls[1]).toMatchObject({
		terms: ['Borealis'],
		excludeSuccessfulTools: ['search_resident_tools'],
	})
	expect(calls[2]).toEqual({ cursor: 'broad-1', maxReadBytes: 8 * 1024 * 1024 - 2000 })
	expect(calls[3]).toEqual({ cursor: 'broad-3', maxReadBytes: 8 * 1024 * 1024 - 3000 })
	expect(records(result?.context)[0]).toMatchObject({
		scannedBytes: 4000,
		incomplete: true,
		continuations: [{ toolName: 'search_resident_tools', input: { cursor: 'broad-4' } }],
	})
})

it('retains both incomplete scan cursors and refuses foreign evidence on the focused page', async () => {
	const f = fixture()
	const evidence = f.page.evidence
	const match = evidence?.matches[0]
	if (!evidence || !match) throw new Error('Missing original.')
	f.search.mockImplementation(async () => ({
		...f.page,
		nextCursor: `cursor-${f.search.mock.calls.length}`,
		incomplete: true,
		evidence: {
			...evidence,
			matches: Array.from({ length: 4 }, (_, seq) => ({
				...match,
				seq: seq + 1,
				excerpt: 'Atlas inspected',
			})),
		},
	}))
	const state = { ...f.state, objective: 'Atlas Borealis', summary: null, wakeEvidence: undefined }
	const result = await f.create({ state, maxChars: 12000 })(f.context)
	expect(records(result?.context)[0]).toMatchObject({
		incomplete: true,
		continuations: [
			{ toolName: 'search_resident_tools', input: { cursor: 'cursor-1' } },
			{ toolName: 'search_resident_tools', input: { cursor: 'cursor-4' } },
		],
	})
	f.search.mockClear()
	f.search.mockImplementation(async () => ({
		...f.page,
		nextCursor: 'continue',
		incomplete: true,
		evidence: {
			...evidence,
			scope:
				f.search.mock.calls.length === 1
					? evidence.scope
					: { ...evidence.scope, projectId: generateProjectId() },
			matches: Array.from({ length: 4 }, (_, seq) => ({
				...match,
				seq: seq + 1,
				excerpt: 'Atlas inspected',
			})),
		},
	}))
	await expect(f.create({ state })(f.context)).rejects.toThrow()
	expect(f.search).toHaveBeenCalledTimes(2)
})

it('rejects late results after parent cancellation', async () => {
	const f = fixture()
	const controller = new AbortController()
	f.search.mockImplementation(async () => {
		controller.abort(new Error('operator stopped'))
		return f.page
	})
	await expect(f.create()({ ...f.context, signal: controller.signal })).rejects.toThrow(
		'operator stopped',
	)
})

it('keeps evidence when two valid resident cursors exceed output room, counting both omitted hints', async () => {
	const f = fixture()
	const evidence = f.page.evidence
	const match = evidence?.matches[0]
	if (!evidence || !match) throw new Error('Missing original.')
	f.search.mockImplementation(async () => ({
		...f.page,
		nextCursor: `cursor-${f.search.mock.calls.length}-${'x'.repeat(8150)}`,
		incomplete: true,
		evidence: {
			...evidence,
			matches: Array.from({ length: 4 }, (_, i) => ({
				...match,
				seq: i + 1,
				excerpt: 'Atlas ORIGINAL_RECORD',
			})),
		},
	}))
	const result = await f.create({
		state: { ...f.state, objective: 'Atlas Borealis', summary: null, wakeEvidence: undefined },
	})(f.context)
	expect(result?.context).toContain('ORIGINAL_RECORD')
	expect(records(result?.context)[0]).toMatchObject({ incomplete: true, omittedContinuations: 2 })
	expect(
		(result?.context?.length ?? 0) - (f.context.prepared.context?.length ?? 0),
	).toBeLessThanOrEqual(6002)
})

it('times out uncooperative I/O without accumulating further reads', async () => {
	vi.useFakeTimers()
	const f = fixture()
	let release: ((page: ResidentToolEvidenceSearchResult) => void) | undefined
	f.search.mockImplementation(
		() =>
			new Promise((resolve) => {
				release = resolve
			}),
	)
	const recall = f.create({ timeoutMs: 10 })
	const first = expect(recall(f.context)).rejects.toThrow()
	await vi.advanceTimersByTimeAsync(11)
	await first
	const next = await recall(f.context)
	expect(next?.context).toContain('"reason":"pending"')
	expect(next?.context).not.toContain('A-73')
	expect(f.search).toHaveBeenCalledTimes(1)
	if (!release) throw new Error('Search did not start.')
	release(f.page)
	await vi.advanceTimersByTimeAsync(0)
})

it('keeps resident archive addresses for duplicates, omitted passages and already visible quotes', async () => {
	const f = fixture()
	const original = f.page.evidence
	const first = original?.matches[0]
	if (!original || !first) throw new Error('Missing fixture evidence.')
	f.search.mockResolvedValue({
		...f.page,
		evidence: {
			...original,
			matches: [
				first,
				{ ...first, seq: 4, address: 'duplicate-address' },
				{ ...first, seq: 5, address: 'correction-address', excerpt: 'DELTA revised B-91' },
			],
		},
	})
	const narrow = records((await f.create({ maxPassages: 1, maxChars: 12000 })(f.context))?.context)
	expect(narrow[0].additionalEvidence[0]).toMatchObject({
		revision: 4,
		address: 'correction-address',
		sessionId: f.original.sessionId,
	})
	expect(narrow[1].otherOccurrences[0]).toMatchObject({
		revision: 4,
		address: 'duplicate-address',
		sessionId: f.original.sessionId,
		seq: 4,
	})
	const visible = records(
		(await f.create({ maxChars: 12000 })({ ...f.context, prepared: { context: first.excerpt } }))
			?.context,
	)
	expect(visible[0].visibleEvidence[0]).toMatchObject({
		textQuote: first.excerpt,
		address: { revision: 4, address: first.address, sessionId: f.original.sessionId },
	})
})
