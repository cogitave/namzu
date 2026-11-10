/**
 * The sweep: what Namzu sets aside on its own, and nothing it deletes.
 *
 * Two things only, both on memories a turn recorded (origin `derived`):
 *
 * - **Unused.** A memory recall has not offered for `retireAfterDays`, counted
 *   from its creation, its last recall, or from when the usage file began
 *   counting, whichever is latest. It is archived with `retiredAt` and
 *   `retiredReason: 'unused'`.
 * - **An exact copy.** Of several records with the same type, title and body,
 *   the newest stays and the rest are archived with `retiredReason:
 *   'duplicate'` and `supersededBy`.
 *
 * What you or Namzu saved on request is never changed. Those records that
 * would have been retired, were they recorded by a turn, are reported as
 * `possiblyStale` so `/memory` can say so; nothing is written for them.
 *
 * Without trustworthy usage counts (`unknown`: the file is missing or could
 * not be read) nothing is retired for being unused; duplicates do not need
 * counts and are still archived.
 *
 * Archiving rewrites the record at the revision the sweep read; a record that
 * changed meanwhile stays. Pure of the terminal: the clock is handed in.
 */

import { type MarkdownMemoryStore, MemoryRevisionConflictError, memoryOrigin } from '@namzu/sdk'

import type { MemoryUsage } from './usage.js'

export const DEFAULT_RETIRE_AFTER_DAYS = 21
export const RETIRED_UNUSED = 'unused'
export const RETIRED_DUPLICATE = 'duplicate'
const DAY_MS = 86_400_000

type MemoryId = Parameters<MarkdownMemoryStore['delete']>[0]

export interface SweepDeps {
	readonly store: MarkdownMemoryStore
	readonly usage: MemoryUsage
	readonly now: () => number
	/** Days without a recall before a recorded memory is retired. 0 never retires for being unused. */
	readonly retireAfterDays: number
}

export interface SweptMemory {
	readonly id: string
	readonly title: string
	readonly reason: typeof RETIRED_UNUSED | typeof RETIRED_DUPLICATE
}

export interface SweepReport {
	readonly archived: readonly SweptMemory[]
	/** Operator and model memories unused for the same time. Not written to. */
	readonly possiblyStale: readonly string[]
	/** Records that changed while the sweep ran and so stayed. */
	readonly kept: number
	/** Why nothing was retired for being unused, when that is so. */
	readonly unusedSkipped?: 'unknown' | 'off'
}

const normalize = (text: string): string =>
	text.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase()

/** The records `/memory` shows as retired carry this. */
export function retiredReasonOf(
	metadata: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
	const reason = metadata?.retiredReason
	return typeof reason === 'string' && typeof metadata?.retiredAt === 'number' ? reason : undefined
}

/** Whether a record has gone unrecalled for `retireAfterDays`, by the counts in `usage`. */
export function isUnused(input: {
	readonly usage: MemoryUsage
	readonly id: string
	readonly touchedAt: number
	readonly at: number
	readonly retireAfterDays: number
}): boolean {
	const counters = input.usage.get(input.id)
	const reference = Math.max(input.touchedAt, counters?.lastRecalledAt ?? 0, input.usage.since)
	return input.at - reference >= input.retireAfterDays * DAY_MS
}

export async function sweepMemory(deps: SweepDeps): Promise<SweepReport> {
	const { store, usage, now, retireAfterDays } = deps
	const at = now()
	const { entries } = await store.list({ status: 'active' })
	const archived: SweptMemory[] = []
	const possiblyStale: string[] = []
	let kept = 0
	const unusedSkipped: SweepReport['unusedSkipped'] =
		retireAfterDays <= 0 ? 'off' : usage.state === 'unknown' ? 'unknown' : undefined

	interface Row {
		readonly id: MemoryId
		readonly record: NonNullable<Awaited<ReturnType<MarkdownMemoryStore['getVersionedRecord']>>>
	}
	const derived: Row[] = []
	const unusedRow = (row: Row): boolean => {
		if (unusedSkipped) return false
		return isUnused({
			usage,
			id: row.id,
			touchedAt: row.record.entry.updatedAt,
			at,
			retireAfterDays,
		})
	}

	for (const entry of entries) {
		const record = await store.getVersionedRecord(entry.id)
		if (!record || record.entry.status !== 'active') continue
		const row: Row = { id: entry.id, record }
		if (memoryOrigin(record.content.metadata) === 'derived') derived.push(row)
		else if (unusedRow(row)) possiblyStale.push(entry.id)
	}

	const archive = async (
		row: Row,
		reason: SweptMemory['reason'],
		extra: Record<string, unknown> = {},
	): Promise<void> => {
		try {
			await store.updateIfRevision(
				row.id,
				{
					status: 'archived',
					metadata: {
						...row.record.content.metadata,
						retiredAt: at,
						retiredReason: reason,
						...extra,
					},
				},
				row.record.revision,
			)
			archived.push({ id: row.id, title: row.record.entry.title, reason })
		} catch (error) {
			if (!(error instanceof MemoryRevisionConflictError)) throw error
			kept += 1
		}
	}

	// Exact copies first, so a copy is retired as a copy and not as unused.
	const groups = new Map<string, Row[]>()
	for (const row of derived) {
		const key = [
			row.record.entry.type ?? '',
			normalize(row.record.entry.title),
			normalize(row.record.content.content),
		].join('\u0000')
		groups.set(key, [...(groups.get(key) ?? []), row])
	}
	const settled = new Set<string>()
	for (const group of groups.values()) {
		if (group.length < 2) continue
		const [newest, ...older] = [...group].sort(
			(a, b) =>
				b.record.entry.updatedAt - a.record.entry.updatedAt ||
				b.record.entry.createdAt - a.record.entry.createdAt ||
				(a.id < b.id ? -1 : 1),
		)
		if (!newest) continue
		for (const row of older) {
			settled.add(row.id)
			await archive(row, RETIRED_DUPLICATE, { supersededBy: newest.id })
		}
	}

	for (const row of derived) {
		if (settled.has(row.id) || !unusedRow(row)) continue
		await archive(row, RETIRED_UNUSED)
	}

	return {
		archived,
		possiblyStale,
		kept,
		...(unusedSkipped ? { unusedSkipped } : {}),
	}
}

/** What `/memory tidy` prints. */
export function describeSweep(report: SweepReport, retireAfterDays: number): string {
	const lines: string[] = []
	if (report.archived.length === 0) lines.push('Nothing to tidy: no memory was set aside.')
	else {
		lines.push(
			`Retired ${report.archived.length} ${report.archived.length === 1 ? 'memory' : 'memories'}. /memory restores them.`,
		)
		for (const item of report.archived)
			lines.push(
				`  ${item.title.replace(/\s+/gu, ' ').trim()} · ${
					item.reason === RETIRED_DUPLICATE
						? 'a newer copy exists'
						: `not recalled for ${retireAfterDays} days`
				}`,
			)
	}
	if (report.unusedSkipped === 'unknown')
		lines.push(
			'Use counts are not known yet, so no memory was retired for being unused. They start counting now.',
		)
	if (report.unusedSkipped === 'off')
		lines.push('memory.retireAfterDays is 0, so no memory is retired for being unused.')
	if (report.possiblyStale.length > 0)
		lines.push(
			`${report.possiblyStale.length} you or Namzu saved ${report.possiblyStale.length === 1 ? 'has' : 'have'} not been recalled for ${retireAfterDays} days. They stay; /memory marks them.`,
		)
	if (report.kept > 0) lines.push(`${report.kept} changed while tidying and stayed.`)
	return lines.join('\n')
}
