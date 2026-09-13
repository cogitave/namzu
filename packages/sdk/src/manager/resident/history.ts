import { z } from 'zod'
import type { ResidentAgendaState } from './agenda.js'
import { ResidentHistoryPageLimit, type ResidentHistoryReadBudget } from './history-disk.js'

const SCAN_BYTES = 8 * 1024 * 1024
const SCAN_REVISIONS = 32
const TEXT_PAGE_CHARS = 6_000

/** @experimental Host-bound historical scope; the upper revision never advances implicitly. */
export interface ResidentHistoryScope {
	readonly tenantId: string
	readonly agentKey: string
	readonly pursuitId: string
	readonly throughRevision: number
}

/** @experimental Revision plus part identifies retained text within one pursuit. */
export interface ResidentHistoryAddress {
	readonly revision: number
	readonly part: number
}

/** @experimental Summary or accepted wake input from a settled historical step. */
export interface ResidentHistoryMatch extends ResidentHistoryAddress {
	readonly step: number
	readonly claimId: string
	readonly kind: 'wait' | 'complete' | 'blocked'
	readonly source: 'summary' | 'wake'
	readonly excerpt: string
	readonly matchingParts: readonly number[]
}

/** @experimental Empty query browses recent steps; cursor is the next inclusive revision. */
export interface ResidentHistorySearchOptions {
	/** Optional per-call ceiling, 1 byte–8 MiB. Defaults to 8 MiB. */
	readonly maxReadBytes?: number
	readonly query?: string
	readonly cursor?: number
	readonly limit?: number
}

/** @experimental Counts describe this page, not the whole history. */
export interface ResidentHistorySearchResult {
	readonly matches: readonly ResidentHistoryMatch[]
	readonly nextCursor: number | null
	readonly scannedRevisions: number
	readonly scannedBytes: number
	readonly unavailableRevisions: readonly number[]
	readonly incomplete: boolean
}

/** @experimental Use the returned nextOffset to continue exact Unicode-safe text. */
export interface ResidentHistoryReadOptions extends ResidentHistoryAddress {
	readonly offset?: number
	/** Optional per-call ceiling, 1 byte–8 MiB. Defaults to 8 MiB. */
	readonly maxReadBytes?: number
}

/** @experimental A recorded claim remains historical evidence, not proof of current validity. */
export interface ResidentHistoryText extends ResidentHistoryAddress {
	readonly step: number
	readonly claimId: string
	readonly kind: 'wait' | 'complete' | 'blocked'
	readonly source: 'summary' | 'wake'
	readonly receivedAt?: number
	readonly text: string
	readonly offset: number
	readonly totalChars: number
	readonly nextOffset: number | null
}

/** @experimental Null with unavailable revisions means unreadable evidence, not proven absence. */
export interface ResidentHistoryReadResult {
	readonly entry: ResidentHistoryText | null
	readonly scannedRevisions: number
	readonly scannedBytes: number
	readonly unavailableRevisions: readonly number[]
}

/** @experimental A backend must enforce its bound scope and bounded reads. */
export interface ResidentHistorySource {
	readonly scope: ResidentHistoryScope
	search(
		options?: ResidentHistorySearchOptions,
		signal?: AbortSignal,
	): Promise<ResidentHistorySearchResult>
	read(
		options: ResidentHistoryReadOptions,
		signal?: AbortSignal,
	): Promise<ResidentHistoryReadResult>
}

type LoadRevision = (
	revision: number,
	budget: ResidentHistoryReadBudget,
) => Promise<ResidentAgendaState>
interface Part {
	source: 'summary' | 'wake'
	text: string
	receivedAt?: number
}
interface Episode {
	step: number
	claimId: string
	kind: 'wait' | 'complete' | 'blocked'
	parts: Part[]
}

function episode(
	before: ResidentAgendaState | null,
	after: ResidentAgendaState | null,
	id: string,
): Episode | null {
	const previous = before?.pursuits.find((p) => p.id === id)?.state
	const current = after?.pursuits.find((p) => p.id === id)?.state
	if (
		!before ||
		!after ||
		!previous ||
		!current ||
		previous.phase !== 'running' ||
		!previous.claimId ||
		current.phase === 'running' ||
		current.claimId !== null ||
		current.summary === null ||
		current.stepsAdmitted !== previous.stepsAdmitted ||
		current.revision !== previous.revision + 1
	)
		return null
	return {
		step: current.stepsAdmitted,
		claimId: previous.claimId,
		kind: current.phase === 'waiting' ? 'wait' : current.phase,
		parts: [
			{ source: 'summary', text: current.summary },
			...(previous.wakeEvidence ?? []).map((entry) => ({
				source: 'wake' as const,
				text: entry.reason,
				receivedAt: entry.receivedAt,
			})),
		],
	}
}

function boundary(text: string, offset: number): boolean {
	const current = text.charCodeAt(offset)
	const previous = text.charCodeAt(offset - 1)
	return !(current >= 0xdc00 && current <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff)
}

function textSlice(text: string, offset: number, maxChars: number): string {
	let end = Math.min(text.length, offset + maxChars)
	if (!boundary(text, end)) end--
	return text.slice(offset, end)
}

/** Internal disk adapter. Other backends may implement ResidentHistorySource directly. */
export function createResidentHistorySource(
	scopeInput: ResidentHistoryScope,
	identity: { identity: string; objective: string },
	load: LoadRevision,
): ResidentHistorySource {
	const scope = Object.freeze({ ...scopeInput })
	const expected = { ...identity }
	const revisionSchema = z.number().int().min(1).max(scope.throughRevision).safe()
	function page(signal: AbortSignal | undefined, requestedBytes: number | undefined) {
		const limit = z
			.number()
			.int()
			.min(1)
			.max(SCAN_BYTES)
			.parse(requestedBytes ?? SCAN_BYTES)
		const budget: ResidentHistoryReadBudget = { remaining: limit, bytesRead: 0, signal }
		const unavailable = new Set<number>()
		let scanned = 0
		const cache = new Map<number, ResidentAgendaState | null>()
		return {
			budget,
			async load(revision: number) {
				signal?.throwIfAborted()
				if (cache.has(revision)) return cache.get(revision) ?? null
				if (scanned >= SCAN_REVISIONS) throw new ResidentHistoryPageLimit()
				scanned++
				let record: ResidentAgendaState | null = null
				try {
					record = await load(revision, budget)
					const pursuit = record.pursuits.find((p) => p.id === scope.pursuitId)
					if (
						record.revision !== revision ||
						record.tenantId !== scope.tenantId ||
						record.agentKey !== scope.agentKey ||
						(pursuit &&
							(pursuit.state.identity !== expected.identity ||
								pursuit.state.objective !== expected.objective))
					)
						throw new Error('History identity does not match its bound pursuit.')
				} catch (error) {
					signal?.throwIfAborted()
					if (error instanceof ResidentHistoryPageLimit) throw error
					unavailable.add(revision)
					record = null
				}
				// Adjacent revisions are reused on the next scan iteration, without
				// keeping the whole archive in memory.
				if (cache.size >= 2) cache.delete(cache.keys().next().value as number)
				cache.set(revision, record)
				return record
			},
			counts: () => ({
				scannedRevisions: scanned,
				scannedBytes: budget.bytesRead,
				unavailableRevisions: [...unavailable],
			}),
		}
	}
	return Object.freeze({
		scope,
		async search(options: ResidentHistorySearchOptions = {}, signal?: AbortSignal) {
			signal?.throwIfAborted()
			const query = z
				.string()
				.max(256)
				.parse(options.query ?? '')
			const limit = z
				.number()
				.int()
				.min(1)
				.max(8)
				.parse(options.limit ?? 5)
			let revision = revisionSchema.parse(options.cursor ?? scope.throughRevision)
			const reader = page(signal, options.maxReadBytes)
			const matches: ResidentHistoryMatch[] = []
			while (revision >= 2 && matches.length < limit) {
				let found: Episode | null
				try {
					const after = await reader.load(revision)
					const before = await reader.load(revision - 1)
					found = episode(before, after, scope.pursuitId)
				} catch (error) {
					if (!(error instanceof ResidentHistoryPageLimit)) throw error
					break
				}
				if (found) {
					const matchingParts = found.parts.flatMap((part, index) =>
						part.text.includes(query) ? [index] : [],
					)
					const part = matchingParts[0]
					const matched = part === undefined ? undefined : found.parts[part]
					if (matched && part !== undefined) {
						let start = Math.max(0, matched.text.indexOf(query) - 120)
						if (!boundary(matched.text, start)) start--
						matches.push({
							revision,
							part,
							step: found.step,
							claimId: found.claimId,
							kind: found.kind,
							source: matched.source,
							excerpt: textSlice(matched.text, start, 512),
							matchingParts,
						})
					}
				}
				revision--
			}
			const nextCursor = revision >= 2 ? revision : null
			const counts = reader.counts()
			return {
				matches,
				nextCursor,
				...counts,
				incomplete: nextCursor !== null || counts.unavailableRevisions.length > 0,
			}
		},
		async read(options: ResidentHistoryReadOptions, signal?: AbortSignal) {
			const revision = revisionSchema.parse(options.revision)
			const part = z.number().int().min(0).max(16).parse(options.part)
			const offset = z
				.number()
				.int()
				.nonnegative()
				.safe()
				.parse(options.offset ?? 0)
			const reader = page(signal, options.maxReadBytes)
			const after = await reader.load(revision)
			const before = revision >= 2 ? await reader.load(revision - 1) : null
			const found = episode(before, after, scope.pursuitId)
			const selected = found?.parts[part]
			if (!selected || !found) return { entry: null, ...reader.counts() }
			if (offset > selected.text.length || !boundary(selected.text, offset))
				throw new Error('Invalid retained text offset; use nextOffset from the previous page.')
			const text = textSlice(selected.text, offset, TEXT_PAGE_CHARS)
			const end = offset + text.length
			return {
				entry: {
					revision,
					part,
					step: found.step,
					claimId: found.claimId,
					kind: found.kind,
					source: selected.source,
					...(selected.receivedAt !== undefined ? { receivedAt: selected.receivedAt } : {}),
					text,
					offset,
					totalChars: selected.text.length,
					nextOffset: end < selected.text.length ? end : null,
				},
				...reader.counts(),
			}
		},
	})
}
