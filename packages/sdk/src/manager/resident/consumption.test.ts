import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { ResidentActivityPage, ResidentActivitySource, ResidentAdmission } from './activity.js'
import { type ResidentConsumptionReceipt, inspectResidentConsumption } from './consumption.js'

const scope = { tenantId: randomUUID(), agentKey: 'reviewer', throughRevision: 4 }
const admission = (revision: number): ResidentAdmission => ({
	revision,
	pursuitRevision: 2,
	pursuitId: randomUUID(),
	claimId: randomUUID(),
	step: 1,
	objective: 'Inspect only.',
})
const first = admission(2)
const second = admission(3)
const receipt = (
	overrides: Partial<ResidentConsumptionReceipt> = {},
): ResidentConsumptionReceipt => ({
	sessionId: randomUUID(),
	turnId: randomUUID(),
	ownTokens: 120,
	treeTokens: 200,
	ownCostUsd: 0.03,
	unpricedOwnTokens: 0,
	usageFinal: true,
	cleanup: 'confirmed',
	verification: 'unconfigured',
	...overrides,
})
const page = (overrides: Partial<ResidentActivityPage> = {}): ResidentActivityPage => ({
	scope,
	fromRevision: 1,
	throughRevision: 4,
	nextCursor: null,
	scannedBytes: 100,
	unavailableRevisions: [],
	admissions: [first, second],
	settlements: [
		{ revision: 4, pursuitId: first.pursuitId, claimId: first.claimId, outcome: 'complete' },
	],
	archivedPursuits: [],
	...overrides,
})
const source = (value = page()): ResidentActivitySource => ({
	scope,
	read: vi.fn().mockResolvedValue(value),
})

it('counts each admitted root once and keeps root and tree totals separate', async () => {
	const resolve = vi
		.fn()
		.mockResolvedValueOnce(receipt())
		.mockResolvedValueOnce(receipt({ verification: 'recorded' }))
	const report = await inspectResidentConsumption(source(), { maxReadBytes: 100, resolve })
	expect(resolve).toHaveBeenCalledTimes(2)
	expect(report.recorded).toEqual({
		ownTokens: 240,
		treeTokens: 400,
		ownCostUsd: 0.06,
		unpricedOwnTokens: 0,
	})
	expect(report.attempts[0]?.settlement?.outcome).toBe('complete')
	expect(report.attempts[1]?.settlement).toBeNull()
	expect(report.usageComplete).toBe(true)
})

it('retains known partial usage while keeping missing receipts and unknown prices explicit', async () => {
	const resolve = vi
		.fn()
		.mockResolvedValueOnce(
			receipt({
				ownTokens: 100,
				treeTokens: null,
				ownCostUsd: 0.01,
				unpricedOwnTokens: 80,
				usageFinal: false,
			}),
		)
		.mockResolvedValueOnce(null)
	const report = await inspectResidentConsumption(source(), { maxReadBytes: 100, resolve })
	expect(report.recorded).toEqual({
		ownTokens: 100,
		treeTokens: 0,
		ownCostUsd: 0.01,
		unpricedOwnTokens: 80,
	})
	expect(report.unknown).toEqual({ ownUsageAttempts: 2, treeUsageAttempts: 2, ownPriceAttempts: 2 })
	expect(report.usageComplete).toBe(false)
	expect(report.attempts[1]?.receiptStatus).toBe('missing')
})

it('unpriced tokens do not turn a known usage receipt into free work', async () => {
	const report = await inspectResidentConsumption(source(page({ admissions: [first] })), {
		maxReadBytes: 100,
		resolve: async () => receipt({ unpricedOwnTokens: 120, ownCostUsd: 0 }),
	})
	expect(report.usageComplete).toBe(true)
	expect(report.unknown.ownPriceAttempts).toBe(1)
	expect(report.recorded.unpricedOwnTokens).toBe(120)
})

it('a copied run receipt invalidates both claims instead of double-counting or choosing one', async () => {
	const copied = receipt()
	const report = await inspectResidentConsumption(source(), {
		maxReadBytes: 100,
		resolve: async () => copied,
	})
	expect(report.recorded.ownTokens).toBe(0)
	expect(report.attempts.map((a) => a.receiptStatus)).toEqual(['duplicate-turn', 'duplicate-turn'])
	expect(report.unknown.ownUsageAttempts).toBe(2)
})

it('does not count different hexadecimal spellings of the same run UUID twice', async () => {
	const lower = receipt({ turnId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa' })
	const resolve = vi
		.fn()
		.mockResolvedValueOnce(lower)
		.mockResolvedValueOnce({ ...lower, turnId: lower.turnId.toUpperCase() })
	const report = await inspectResidentConsumption(source(), {
		maxReadBytes: 100,
		resolve,
	})
	expect(report.recorded.ownTokens).toBe(0)
	expect(report.attempts.map((a) => a.receiptStatus)).toEqual(['duplicate-turn', 'duplicate-turn'])
})

it('joins UUID aliases without rewriting host lookup identifiers or accepting duplicate admissions', async () => {
	const changed = { ...first, claimId: 'AAAAAAAA-2222-4222-8222-AAAAAAAAAAAA' }
	const withSettlement = page({
		admissions: [changed],
		settlements: [
			{
				revision: 4,
				pursuitId: first.pursuitId.toUpperCase(),
				claimId: changed.claimId.toLowerCase(),
				outcome: 'complete',
			},
		],
	})
	const report = await inspectResidentConsumption(source(withSettlement), {
		maxReadBytes: 100,
		resolve: async (admission) => {
			expect(admission.claimId).toBe(changed.claimId)
			return receipt()
		},
	})
	expect(report.attempts[0]?.settlement?.outcome).toBe('complete')
	await expect(
		inspectResidentConsumption(
			source(
				page({
					admissions: [
						changed,
						{ ...changed, revision: 3, claimId: changed.claimId.toLowerCase() },
					],
				}),
			),
			{ maxReadBytes: 100, resolve: async () => receipt() },
		),
	).rejects.toThrow('Duplicate resident admission')
})

it('reserves receipt read bounds before resolving and does not call deferred adapters', async () => {
	const resolve = vi.fn(async () => receipt())
	const report = await inspectResidentConsumption(
		source(),
		{ maxReadBytes: 100, resolve },
		{ maxReceiptBytes: 100 },
	)
	expect(resolve).toHaveBeenCalledTimes(1)
	expect(report.receiptBytesReserved).toBe(100)
	expect(report.attempts[1]?.receiptStatus).toBe('deferred')
	expect(report.usageComplete).toBe(false)
})

it('rejects unsafe numeric receipts without leaking adapter exception text', async () => {
	for (const bad of [
		receipt({ ownTokens: -1 }),
		receipt({ treeTokens: 1 }),
		receipt({ ownCostUsd: Number.NaN }),
		receipt({ unpricedOwnTokens: 121 }),
	]) {
		const report = await inspectResidentConsumption(source(page({ admissions: [first] })), {
			maxReadBytes: 100,
			resolve: async () => bad,
		})
		expect(report.attempts[0]?.receiptStatus).toBe('invalid')
		expect(report.recorded.ownTokens).toBe(0)
	}
	const report = await inspectResidentConsumption(source(), {
		maxReadBytes: 100,
		resolve: async () => {
			throw new Error('private credential text')
		},
	})
	expect(JSON.stringify(report)).not.toContain('private credential')
})

it('missing revision evidence prevents a lifetime completeness claim even with final usage', async () => {
	const report = await inspectResidentConsumption(source(page({ unavailableRevisions: [1] })), {
		maxReadBytes: 100,
		resolve: async () => receipt(),
	})
	expect(report.historyComplete).toBe(false)
	expect(report.usageComplete).toBe(false)
})

it('stops on a zero-progress byte boundary and preserves the exact cursor', async () => {
	const s = source(
		page({ throughRevision: 0, nextCursor: 1, admissions: [], settlements: [], scannedBytes: 0 }),
	)
	const report = await inspectResidentConsumption(s, {
		maxReadBytes: 100,
		resolve: async () => null,
	})
	expect(s.read).toHaveBeenCalledTimes(1)
	expect(report).toMatchObject({ nextCursor: 1, historyComplete: false, throughRevision: 0 })
})

it('combines consecutive pages and retains a settlement crossing the page boundary', async () => {
	const s = source()
	vi.mocked(s.read)
		.mockResolvedValueOnce(
			page({ throughRevision: 2, nextCursor: 3, admissions: [first], settlements: [] }),
		)
		.mockResolvedValueOnce(
			page({ fromRevision: 3, admissions: [second], archivedPursuits: [first.pursuitId] }),
		)
	const report = await inspectResidentConsumption(s, {
		maxReadBytes: 100,
		resolve: async () => receipt(),
	})
	expect(report.attempts[0]?.settlement?.outcome).toBe('complete')
	expect(report.archivedPursuits).toEqual([first.pursuitId])
	expect(report.historyBytes).toBe(200)
})

it('a continuation page is not labelled a lifetime total', async () => {
	const report = await inspectResidentConsumption(
		source(page({ fromRevision: 3, admissions: [second] })),
		{ maxReadBytes: 100, resolve: async () => receipt() },
		{ cursor: 3 },
	)
	expect(report.historyComplete).toBe(false)
	expect(report.nextCursor).toBeNull()
})

it('rejects a foreign source page, overlapping cursor or dishonest read budget', async () => {
	for (const bad of [
		page({ scope: { ...scope, agentKey: 'other' } }),
		page({ fromRevision: 2 }),
		page({ nextCursor: 4 }),
		page({ scannedBytes: 9e9 }),
	])
		await expect(
			inspectResidentConsumption(source(bad), { maxReadBytes: 100, resolve: async () => null }),
		).rejects.toThrow('Invalid resident activity page')
})

it('refuses duplicate admissions and unsafe aggregate integer totals', async () => {
	await expect(
		inspectResidentConsumption(source(page({ admissions: [first, first] })), {
			maxReadBytes: 100,
			resolve: async () => null,
		}),
	).rejects.toThrow('Duplicate resident admission')
	await expect(
		inspectResidentConsumption(source(), {
			maxReadBytes: 100,
			resolve: async () =>
				receipt({ ownTokens: Number.MAX_SAFE_INTEGER, treeTokens: Number.MAX_SAFE_INTEGER }),
		}),
	).rejects.toThrow('safe integer')
})

it('cancellation during resolution propagates instead of pretending a receipt is missing', async () => {
	const controller = new AbortController()
	await expect(
		inspectResidentConsumption(
			source(),
			{
				maxReadBytes: 100,
				resolve: async () => {
					controller.abort(new Error('stop now'))
					throw controller.signal.reason
				},
			},
			{},
			controller.signal,
		),
	).rejects.toThrow('stop now')
})

it('normalizes adapter records and rejects claims or settlements outside their admission scope', async () => {
	const extra = { ...first, privateMetadata: 'do not copy' }
	const result = await inspectResidentConsumption(source(page({ admissions: [extra] })), {
		maxReadBytes: 100,
		resolve: async () => receipt(),
	})
	expect(JSON.stringify(result)).not.toContain('privateMetadata')
	for (const bad of [
		page({ admissions: [{ ...first, revision: 5 }] }),
		page({
			settlements: [
				{ revision: 4, claimId: first.claimId, pursuitId: randomUUID(), outcome: 'complete' },
			],
		}),
		page({
			settlements: [
				{ revision: 1, claimId: first.claimId, pursuitId: first.pursuitId, outcome: 'complete' },
			],
		}),
	])
		await expect(
			inspectResidentConsumption(source(bad), {
				maxReadBytes: 100,
				resolve: async () => receipt(),
			}),
		).rejects.toThrow()
})

it('a resolver cannot mutate the authoritative admission it was asked to inspect', async () => {
	const report = await inspectResidentConsumption(source(page({ admissions: [first] })), {
		maxReadBytes: 100,
		resolve: async (admission) => {
			expect(Reflect.set(admission, 'claimId', randomUUID())).toBe(false)
			return receipt()
		},
	})
	expect(report.attempts[0]?.claimId).toBe(first.claimId)
})
