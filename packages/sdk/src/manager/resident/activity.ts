import { z } from 'zod'
import type { ResidentAgendaState } from './agenda.js'
import { ResidentHistoryPageLimit, type ResidentHistoryReadBudget } from './history-disk.js'

/** @experimental An immutable upper boundary; new work requires a new source. */
export interface ResidentActivityScope {
	readonly tenantId: string
	readonly agentKey: string
	readonly throughRevision: number
}

/** @experimental Admission is authority to inspect an attempt, not proof that it executed. */
export interface ResidentAdmission {
	readonly revision: number
	readonly pursuitRevision: number
	readonly pursuitId: string
	readonly claimId: string
	readonly step: number
	readonly objective: string
}

/** @experimental Settlement is an agenda decision, not proof of verification or delivery. */
export interface ResidentSettlement {
	readonly revision: number
	readonly pursuitId: string
	readonly claimId: string
	readonly outcome: 'wait' | 'complete' | 'blocked'
}

/** @experimental Forward pages; cursor is the next revision to inspect, initially 1. */
export interface ResidentActivityOptions {
	readonly cursor?: number
	readonly maxRevisions?: number
	readonly maxReadBytes?: number
}

/** @experimental Gaps stay explicit; counts cover only the scanned revision range. */
export interface ResidentActivityPage {
	readonly scope: ResidentActivityScope
	readonly fromRevision: number
	readonly throughRevision: number
	readonly nextCursor: number | null
	readonly scannedBytes: number
	readonly unavailableRevisions: readonly number[]
	readonly admissions: readonly ResidentAdmission[]
	readonly settlements: readonly ResidentSettlement[]
	readonly archivedPursuits: readonly string[]
}

/** @experimental A backend must enforce scope, cancellation and read bounds. */
export interface ResidentActivitySource {
	readonly scope: ResidentActivityScope
	read(options?: ResidentActivityOptions, signal?: AbortSignal): Promise<ResidentActivityPage>
}

/** Internal adapter for the immutable disk agenda. */
export function createResidentActivitySource(
	scopeInput: ResidentActivityScope,
	load: (revision: number, budget: ResidentHistoryReadBudget) => Promise<ResidentAgendaState>,
): ResidentActivitySource {
	const scope = Object.freeze(
		z
			.object({
				tenantId: z.string().uuid(),
				agentKey: z.string().min(1).max(200),
				throughRevision: z.number().int().positive().safe(),
			})
			.parse(scopeInput),
	)
	return {
		scope,
		async read(options: ResidentActivityOptions = {}, signal?: AbortSignal) {
			const from = z
				.number()
				.int()
				.positive()
				.max(scope.throughRevision)
				.parse(options.cursor ?? 1)
			const count = z
				.number()
				.int()
				.positive()
				.max(32)
				.parse(options.maxRevisions ?? 32)
			const budget: ResidentHistoryReadBudget = {
				remaining: z
					.number()
					.int()
					.positive()
					.max(8 * 1024 * 1024)
					.parse(options.maxReadBytes ?? 8 * 1024 * 1024),
				bytesRead: 0,
				signal,
			}
			const unavailable = new Set<number>()
			const read = async (revision: number) => {
				signal?.throwIfAborted()
				try {
					const state = await load(revision, budget)
					if (
						state.tenantId !== scope.tenantId ||
						state.agentKey !== scope.agentKey ||
						state.revision !== revision
					)
						throw new Error('Resident activity scope mismatch.')
					return state
				} catch (error) {
					signal?.throwIfAborted()
					if (error instanceof ResidentHistoryPageLimit) throw error
					unavailable.add(revision)
					return null
				}
			}
			const admissions: ResidentAdmission[] = []
			const settlements: ResidentSettlement[] = []
			const archivedPursuits: string[] = []
			let through = from - 1
			try {
				let before = from > 1 ? await read(from - 1) : null
				for (
					let revision = from;
					revision <= Math.min(scope.throughRevision, from + count - 1);
					revision++
				) {
					const after = await read(revision)
					if (before && after) {
						for (const pursuit of after.pursuits) {
							const previous = before.pursuits.find((p) => p.id === pursuit.id)?.state
							const current = pursuit.state
							if (!previous) continue
							if (
								current.revision === previous.revision + 1 &&
								previous.phase !== 'running' &&
								current.phase === 'running' &&
								current.claimId &&
								current.stepsAdmitted === previous.stepsAdmitted + 1
							) {
								admissions.push({
									revision,
									pursuitRevision: current.revision,
									pursuitId: pursuit.id,
									claimId: current.claimId,
									step: current.stepsAdmitted,
									objective: current.objective,
								})
							}
							if (
								current.revision === previous.revision + 1 &&
								previous.phase === 'running' &&
								previous.claimId &&
								current.phase !== 'running' &&
								current.claimId === null &&
								current.stepsAdmitted === previous.stepsAdmitted
							) {
								settlements.push({
									revision,
									pursuitId: pursuit.id,
									claimId: previous.claimId,
									outcome: current.phase === 'waiting' ? 'wait' : current.phase,
								})
							}
						}
						if (after.archiveHead === revision)
							for (const pursuit of before.pursuits)
								if (!after.pursuits.some((p) => p.id === pursuit.id))
									archivedPursuits.push(pursuit.id)
					}
					through = revision
					before = after
				}
			} catch (error) {
				if (!(error instanceof ResidentHistoryPageLimit)) throw error
			}
			return {
				scope,
				fromRevision: from,
				throughRevision: through,
				nextCursor: through < scope.throughRevision ? through + 1 : null,
				scannedBytes: budget.bytesRead,
				unavailableRevisions: [...unavailable],
				admissions,
				settlements,
				archivedPursuits,
			}
		},
	}
}
