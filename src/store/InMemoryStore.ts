import type { PaginatedResponse, PaginationParams } from '../contracts/index.js'

export interface Identifiable {
	id: string
}

export interface Timestamped {
	created_at: string
}

export class InMemoryStore<T extends Identifiable & Timestamped> {
	protected items: Map<string, T> = new Map()

	get(id: string): T | undefined {
		return this.items.get(id)
	}

	has(id: string): boolean {
		return this.items.has(id)
	}

	set(item: T): void {
		this.items.set(item.id, item)
	}

	delete(id: string): boolean {
		return this.items.delete(id)
	}

	size(): number {
		return this.items.size
	}

	all(): T[] {
		return Array.from(this.items.values())
	}

	paginate(items: T[], params: PaginationParams = {}): PaginatedResponse<T> {
		const { limit = 20, order = 'desc', after, before } = params

		let sorted = [...items]
		sorted.sort((a, b) => {
			const cmp = a.created_at.localeCompare(b.created_at)
			return order === 'desc' ? -cmp : cmp
		})

		if (after) {
			const idx = sorted.findIndex((item) => item.id === after)
			if (idx !== -1) sorted = sorted.slice(idx + 1)
		}
		if (before) {
			const idx = sorted.findIndex((item) => item.id === before)
			if (idx !== -1) sorted = sorted.slice(0, idx)
		}

		const sliced = sorted.slice(0, Math.min(limit, 100))

		return {
			data: sliced,
			has_more: sorted.length > sliced.length,
			first_id: sliced[0]?.id ?? null,
			last_id: sliced[sliced.length - 1]?.id ?? null,
		}
	}

	list(params: PaginationParams = {}): PaginatedResponse<T> {
		return this.paginate(this.all(), params)
	}
}
