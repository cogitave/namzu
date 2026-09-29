import type { MemoryId } from '../../types/ids/index.js'
import type {
	MemoryIndex,
	MemoryIndexEntry,
	MemorySearchParams,
	MemorySearchResult,
} from '../../types/memory/index.js'

function terms(text: string): Set<string> {
	return new Set(
		text
			.normalize('NFKC')
			.toLowerCase()
			.match(/[\p{L}\p{N}]+/gu) ?? [],
	)
}

/** Exact normalized word membership; no substring, stemming or alias inference. */
export function matchesMemoryIdentifier(text: string, identifiers: ReadonlySet<string>): boolean {
	for (const match of text
		.normalize('NFKC')
		.toLowerCase()
		.matchAll(/[\p{L}\p{N}_]+/gu)) {
		if (identifiers.has(match[0])) return true
	}
	return false
}

interface MemoryScanSelection {
	readonly entries: readonly MemoryIndexEntry[]
	readonly truncated: boolean
	readonly scannedCount: number
	readonly nextScanOffset?: number
}

/** Select a bounded, resumable snapshot of indexed candidates before reading any bodies. */
export function selectMemorySearchCandidates(
	entries: readonly MemoryIndexEntry[],
	params: MemorySearchParams,
): MemoryScanSelection {
	if (
		params.maxScanned !== undefined &&
		(!Number.isSafeInteger(params.maxScanned) || params.maxScanned < 1)
	) {
		throw new RangeError('maxScanned must be a positive safe integer')
	}
	if (
		params.scanOffset !== undefined &&
		(!Number.isSafeInteger(params.scanOffset) || params.scanOffset < 0)
	) {
		throw new RangeError('scanOffset must be a nonnegative safe integer')
	}
	const query = terms(params.query ?? '')
	if (params.query?.trim() && query.size === 0)
		return { entries: [], truncated: false, scannedCount: 0 }
	const bodySearch =
		query.size > 0 ||
		Boolean(params.requiredIdentifiers?.length) ||
		params.maxScanned !== undefined ||
		params.scanOffset !== undefined
	if (!bodySearch) return { entries, truncated: false, scannedCount: 0 }
	const ordered = [...entries].sort(
		(a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
	)
	const start = params.scanOffset ?? 0
	const selected = ordered.slice(
		start,
		params.maxScanned === undefined ? undefined : start + params.maxScanned,
	)
	const next = start + selected.length
	return {
		entries: selected,
		truncated: next < ordered.length,
		scannedCount: selected.length,
		...(next < ordered.length ? { nextScanOffset: next } : {}),
	}
}

/** Shared lexical ranking; a caller-owned index can omit body content. */
export function searchMemoryEntries(
	entries: readonly MemoryIndexEntry[],
	params: MemorySearchParams,
	contentOf: (id: MemoryId) => string = () => '',
): MemorySearchResult {
	const query = terms(params.query ?? '')
	const identifiers = new Set(
		params.requiredIdentifiers?.map((id) => id.normalize('NFKC').toLowerCase()),
	)
	const candidates = entries.filter(
		(entry) =>
			(!params.status || entry.status === params.status) &&
			(!params.tags?.length || params.tags.every((tag) => entry.tags.includes(tag))),
	)
	const selection = selectMemorySearchCandidates(candidates, params)
	const ranked = selection.entries
		.filter(
			(entry) =>
				!identifiers.size ||
				[entry.id, entry.title, entry.summary, contentOf(entry.id)].some((text) =>
					matchesMemoryIdentifier(text, identifiers),
				),
		)
		.map((entry) => {
			let coverage = 0
			let score = 0
			if (query.size > 0) {
				// A name is a title spelled as a slug and a description is a
				// summary kept to one line; each scores as the field it stands in for.
				const title = terms(`${entry.title} ${(entry.name ?? '').replace(/-/g, ' ')}`)
				const summary = terms(`${entry.summary} ${entry.description ?? ''}`)
				const body = terms(contentOf(entry.id))
				for (const term of query) {
					const weight =
						(title.has(term) ? 8 : 0) + (summary.has(term) ? 4 : 0) + (body.has(term) ? 1 : 0)
					if (weight > 0) coverage++
					score += weight
				}
			}
			return { entry, coverage, score }
		})
		.filter(({ coverage }) => query.size === 0 || coverage > 0)
		.sort(
			(a, b) =>
				b.coverage - a.coverage ||
				b.score - a.score ||
				b.entry.updatedAt - a.entry.updatedAt ||
				(a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0),
		)
	return {
		entries: ranked.slice(0, params.limit ?? ranked.length).map(({ entry }) => entry),
		totalCount: ranked.length,
		...(params.maxScanned !== undefined || params.scanOffset !== undefined
			? {
					truncated: selection.truncated,
					scannedCount: selection.scannedCount,
					...(selection.nextScanOffset !== undefined
						? { nextScanOffset: selection.nextScanOffset }
						: {}),
				}
			: {}),
	}
}

export class InMemoryMemoryIndex implements MemoryIndex {
	private entries = new Map<string, MemoryIndexEntry>()

	search(params: MemorySearchParams): MemorySearchResult {
		return searchMemoryEntries([...this.entries.values()], params)
	}

	getEntry(id: MemoryId): MemoryIndexEntry | undefined {
		return this.entries.get(id)
	}

	allEntries(): readonly MemoryIndexEntry[] {
		return Array.from(this.entries.values())
	}

	count(): number {
		return this.entries.size
	}

	rebuild(entries: MemoryIndexEntry[]): void {
		this.entries.clear()
		for (const entry of entries) {
			this.entries.set(entry.id, entry)
		}
	}

	set(entry: MemoryIndexEntry): void {
		this.entries.set(entry.id, entry)
	}

	remove(id: MemoryId): boolean {
		return this.entries.delete(id)
	}
}
