import type { MemoryId } from '../../types/ids/index.js'
import type {
	MemoryIndex,
	MemoryIndexEntry,
	MemorySearchParams,
	MemorySearchResult,
} from '../../types/memory/index.js'

export class InMemoryMemoryIndex implements MemoryIndex {
	private entries = new Map<string, MemoryIndexEntry>()

	search(params: MemorySearchParams): MemorySearchResult {
		let results = Array.from(this.entries.values())

		if (params.query) {
			const q = params.query.toLowerCase()
			results = results.filter(
				(e) => e.title.toLowerCase().includes(q) || e.summary.toLowerCase().includes(q),
			)
		}

		if (params.tags && params.tags.length > 0) {
			const requiredTags = params.tags
			results = results.filter((e) => requiredTags.every((tag) => e.tags.includes(tag)))
		}

		if (params.status) {
			results = results.filter((e) => e.status === params.status)
		}

		results.sort((a, b) => b.updatedAt - a.updatedAt)

		const totalCount = results.length
		const limit = params.limit ?? totalCount

		return {
			entries: results.slice(0, limit),
			totalCount,
		}
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
