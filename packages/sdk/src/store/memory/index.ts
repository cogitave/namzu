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

/** Shared lexical ranking; a caller-owned index can omit body content. */
export function searchMemoryEntries(
	entries: readonly MemoryIndexEntry[],
	params: MemorySearchParams,
	contentOf: (id: MemoryId) => string = () => '',
): MemorySearchResult {
	const query = terms(params.query ?? '')
	if (params.query?.trim() && query.size === 0) return { entries: [], totalCount: 0 }
	const ranked = entries
		.filter(
			(entry) =>
				(!params.status || entry.status === params.status) &&
				(!params.tags?.length || params.tags.every((tag) => entry.tags.includes(tag))),
		)
		.map((entry) => {
			let coverage = 0
			let score = 0
			if (query.size > 0) {
				const title = terms(entry.title)
				const summary = terms(entry.summary)
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
