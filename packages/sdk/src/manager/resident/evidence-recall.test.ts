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
