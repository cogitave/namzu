import { z } from 'zod'
import type {
	ResidentActivityScope,
	ResidentActivitySource,
	ResidentAdmission,
	ResidentSettlement,
} from './activity.js'

const count = z.number().int().nonnegative().safe()
const uuidKey = (id: string) => id.toLowerCase()
const admissionSchema = z.object({
	revision: count.positive(),
	pursuitRevision: count.positive(),
	pursuitId: z.string().uuid(),
	claimId: z.string().uuid(),
	step: count.positive(),
	objective: z.string().min(1).max(8000),
})
const settlementSchema = z.object({
	revision: count.positive(),
	pursuitId: z.string().uuid(),
	claimId: z.string().uuid(),
	outcome: z.enum(['wait', 'complete', 'blocked']),
})
const receiptSchema = z
	.object({
		/** The resident step's turn: one receipt per turn, whose session holds its log. */
		sessionId: z.string().uuid(),
		turnId: z.string().uuid(),
		/** Own usage includes retry and side-call spend; never add cache buckets again. */
		ownTokens: count.nullable(),
		treeTokens: count.nullable(),
		ownCostUsd: z.number().nonnegative().finite().nullable(),
		unpricedOwnTokens: count.nullable(),
		usageFinal: z.boolean(),
		cleanup: z.enum(['confirmed', 'unconfirmed', 'unknown']),
		verification: z.enum(['recorded', 'unconfigured', 'unconfirmed']),
	})
	.superRefine((receipt, ctx) => {
		if (
			receipt.ownTokens !== null &&
			receipt.treeTokens !== null &&
			receipt.treeTokens < receipt.ownTokens
		)
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Tree usage is below own usage.' })
		if (
			receipt.ownTokens !== null &&
			receipt.unpricedOwnTokens !== null &&
			receipt.unpricedOwnTokens > receipt.ownTokens
		)
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Unpriced usage exceeds own usage.' })
	})

/** @experimental Host-authenticated cumulative root receipt. Cost covers this root only. */
export type ResidentConsumptionReceipt = z.infer<typeof receiptSchema>

/** @experimental A host resolves only authoritative admitted claims and bounds each read. */
export interface ResidentConsumptionResolver {
	/** Worst-case bytes read per resolution; reserved before calling the adapter. */
	readonly maxReadBytes: number
	resolve(
		admission: ResidentAdmission,
		signal?: AbortSignal,
	): Promise<ResidentConsumptionReceipt | null>
}

/** @experimental Bounds the entire inspection, not just each page. No inference or writes. */
export interface ResidentConsumptionOptions {
	readonly cursor?: number
	readonly maxRevisions?: number
	readonly maxHistoryBytes?: number
	readonly maxReceiptBytes?: number
}

/** @experimental Missing and deferred receipts never establish zero usage. */
export interface ResidentConsumptionAttempt extends ResidentAdmission {
	readonly settlement: ResidentSettlement | null
	readonly receipt: ResidentConsumptionReceipt | null
	readonly receiptStatus: 'available' | 'missing' | 'invalid' | 'deferred' | 'duplicate-turn'
}

/** @experimental An evidence projection, not a bill or an enforced spending cap. */
export interface ResidentConsumptionReport {
	readonly scope: ResidentActivityScope
	readonly fromRevision: number
	readonly throughRevision: number
	readonly nextCursor: number | null
	readonly historyComplete: boolean
	readonly unavailableRevisions: readonly number[]
	readonly historyBytes: number
	readonly receiptBytesReserved: number
	readonly archivedPursuits: readonly string[]
	readonly attempts: readonly ResidentConsumptionAttempt[]
	readonly recorded: {
		readonly ownTokens: number
		readonly treeTokens: number
		readonly ownCostUsd: number
		readonly unpricedOwnTokens: number
	}
	readonly unknown: {
		readonly ownUsageAttempts: number
		readonly treeUsageAttempts: number
		readonly ownPriceAttempts: number
	}
	/** Requires complete history and final receipts; says nothing about external billing. */
	readonly usageComplete: boolean
}

/**
 * @experimental Inspect cumulative root receipts once per admitted claim. Historical
 * archive/reconcile events never erase consumption. Tree tokens are a separate total:
 * adding them to own tokens would count the root twice. Descendant prices are unknown.
 */
export async function inspectResidentConsumption(
	source: ResidentActivitySource,
	resolver: ResidentConsumptionResolver,
	options: ResidentConsumptionOptions = {},
	signal?: AbortSignal,
): Promise<ResidentConsumptionReport> {
	const scope = z
		.object({
			tenantId: z.string().uuid(),
			agentKey: z.string().min(1).max(200),
			throughRevision: count.positive(),
		})
		.parse(source.scope)
	const from = z
		.number()
		.int()
		.positive()
		.max(scope.throughRevision)
		.parse(options.cursor ?? 1)
	const maxRevisions = z
		.number()
		.int()
		.positive()
		.max(4096)
		.parse(options.maxRevisions ?? 256)
	const maxHistoryBytes = z
		.number()
		.int()
		.positive()
		.max(8 * 1024 * 1024)
		.parse(options.maxHistoryBytes ?? 8 * 1024 * 1024)
	const maxReceiptBytes = z
		.number()
		.int()
		.nonnegative()
		.max(64 * 1024 * 1024)
		.parse(options.maxReceiptBytes ?? 16 * 1024 * 1024)
	const resolutionBytes = z
		.number()
		.int()
		.positive()
		.max(1024 * 1024)
		.parse(resolver.maxReadBytes)
	const admissions = new Map<string, ResidentAdmission>()
	const settlements = new Map<string, ResidentSettlement>()
	const unavailable = new Set<number>()
	const archived = new Map<string, string>()
	let cursor: number | null = from
	let through = from - 1
	let historyBytes = 0
	while (cursor !== null && through - from + 1 < maxRevisions && historyBytes < maxHistoryBytes) {
		signal?.throwIfAborted()
		const page = await source.read(
			{
				cursor,
				maxRevisions: Math.min(32, maxRevisions - (through - from + 1)),
				maxReadBytes: maxHistoryBytes - historyBytes,
			},
			signal,
		)
		signal?.throwIfAborted()
		if (
			page.scope.tenantId !== scope.tenantId ||
			page.scope.agentKey !== scope.agentKey ||
			page.scope.throughRevision !== scope.throughRevision ||
			page.fromRevision !== cursor ||
			!Number.isSafeInteger(page.throughRevision) ||
			page.throughRevision < cursor - 1 ||
			page.throughRevision > Math.min(scope.throughRevision, from + maxRevisions - 1) ||
			!Number.isSafeInteger(page.scannedBytes) ||
			page.scannedBytes < 0 ||
			page.scannedBytes > maxHistoryBytes - historyBytes ||
			page.nextCursor !==
				(page.throughRevision === scope.throughRevision ? null : page.throughRevision + 1)
		)
			throw new Error('Invalid resident activity page.')
		if (
			page.admissions.length > 32 ||
			page.settlements.length > 32 ||
			page.archivedPursuits.length > 1024
		)
			throw new Error('Resident activity page exceeds event bounds.')
		if (page.unavailableRevisions.length > 33) throw new Error('Invalid unavailable revision list.')
		for (const revision of page.unavailableRevisions) {
			count.positive().parse(revision)
			if (revision < Math.max(1, cursor - 1) || revision > page.throughRevision)
				throw new Error('Unavailable revision is outside the page.')
			unavailable.add(revision)
		}
		for (const raw of page.admissions) {
			const admission = Object.freeze(admissionSchema.parse(raw))
			if (admission.revision < cursor || admission.revision > page.throughRevision)
				throw new Error('Resident admission is outside its history page.')
			if (admissions.has(uuidKey(admission.claimId)))
				throw new Error('Duplicate resident admission.')
			admissions.set(uuidKey(admission.claimId), admission)
		}
		for (const raw of page.settlements) {
			const settlement = Object.freeze(settlementSchema.parse(raw))
			if (settlement.revision < cursor || settlement.revision > page.throughRevision)
				throw new Error('Resident settlement is outside its history page.')
			if (settlements.has(uuidKey(settlement.claimId)))
				throw new Error('Duplicate resident settlement.')
			settlements.set(uuidKey(settlement.claimId), settlement)
		}
		for (const id of page.archivedPursuits) archived.set(uuidKey(z.string().uuid().parse(id)), id)
		historyBytes += page.scannedBytes
		through = page.throughRevision
		if (page.nextCursor === cursor) break
		cursor = page.nextCursor
	}
	const attempts: ResidentConsumptionAttempt[] = []
	let receiptBytesReserved = 0
	for (const admission of admissions.values()) {
		signal?.throwIfAborted()
		const settlement = settlements.get(uuidKey(admission.claimId))
		if (
			settlement &&
			(uuidKey(settlement.pursuitId) !== uuidKey(admission.pursuitId) ||
				settlement.revision <= admission.revision)
		)
			throw new Error('Resident settlement does not follow its admitted claim.')
		let receipt: ResidentConsumptionReceipt | null = null
		let receiptStatus: ResidentConsumptionAttempt['receiptStatus'] = 'deferred'
		if (receiptBytesReserved + resolutionBytes <= maxReceiptBytes) {
			receiptBytesReserved += resolutionBytes
			try {
				const value = await resolver.resolve(admission, signal)
				signal?.throwIfAborted()
				receipt = value === null ? null : receiptSchema.parse(value)
				receiptStatus = receipt ? 'available' : 'missing'
			} catch {
				signal?.throwIfAborted()
				receiptStatus = 'invalid'
			}
		}
		attempts.push({
			...admission,
			settlement: settlements.get(uuidKey(admission.claimId)) ?? null,
			receipt,
			receiptStatus,
		})
	}
	// A copied root receipt must not authenticate two claims. Exclude BOTH records.
	const turnCounts = new Map<string, number>()
	for (const { receipt } of attempts)
		if (receipt)
			turnCounts.set(uuidKey(receipt.turnId), (turnCounts.get(uuidKey(receipt.turnId)) ?? 0) + 1)
	const checked = attempts.map((attempt) =>
		attempt.receipt && (turnCounts.get(uuidKey(attempt.receipt.turnId)) ?? 0) > 1
			? { ...attempt, receipt: null, receiptStatus: 'duplicate-turn' as const }
			: attempt,
	)
	const recorded = { ownTokens: 0, treeTokens: 0, ownCostUsd: 0, unpricedOwnTokens: 0 }
	const unknown = { ownUsageAttempts: 0, treeUsageAttempts: 0, ownPriceAttempts: 0 }
	const add = (a: number, b: number) => {
		const result = a + b
		if (!Number.isSafeInteger(result))
			throw new Error('Resident consumption exceeds the safe integer range.')
		return result
	}
	let priceCorrection = 0
	for (const { receipt } of checked) {
		if (!receipt?.usageFinal || receipt.ownTokens === null) unknown.ownUsageAttempts++
		if (!receipt?.usageFinal || receipt.treeTokens === null) unknown.treeUsageAttempts++
		if (
			!receipt?.usageFinal ||
			receipt.ownCostUsd === null ||
			receipt.unpricedOwnTokens === null ||
			receipt.unpricedOwnTokens > 0
		)
			unknown.ownPriceAttempts++
		recorded.ownTokens = add(recorded.ownTokens, receipt?.ownTokens ?? 0)
		recorded.treeTokens = add(recorded.treeTokens, receipt?.treeTokens ?? 0)
		recorded.unpricedOwnTokens = add(recorded.unpricedOwnTokens, receipt?.unpricedOwnTokens ?? 0)
		// Compensated addition limits drift; provider prices are still estimates, not a bill.
		const y = (receipt?.ownCostUsd ?? 0) - priceCorrection
		const next = recorded.ownCostUsd + y
		priceCorrection = next - recorded.ownCostUsd - y
		if (!Number.isFinite(next)) throw new Error('Resident cost exceeds the supported range.')
		recorded.ownCostUsd = next
	}
	const historyComplete = from === 1 && cursor === null && unavailable.size === 0
	return {
		scope,
		fromRevision: from,
		throughRevision: through,
		nextCursor: cursor,
		historyComplete,
		unavailableRevisions: [...unavailable],
		historyBytes,
		receiptBytesReserved,
		archivedPursuits: [...archived.values()],
		attempts: checked,
		recorded,
		unknown,
		usageComplete:
			historyComplete && unknown.ownUsageAttempts === 0 && unknown.treeUsageAttempts === 0,
	}
}
