import type { MemoryId } from '../ids/index.js'

export type MemoryStatus = 'active' | 'archived'

export function assertMemoryStatus(status: MemoryStatus): void {
	switch (status) {
		case 'active':
		case 'archived':
			return
		default: {
			const _exhaustive: never = status
			throw new Error(`Unknown MemoryStatus: ${_exhaustive}`)
		}
	}
}

export interface MemoryIndexEntry {
	readonly id: MemoryId
	readonly title: string
	readonly summary: string
	readonly tags: readonly string[]
	readonly status: MemoryStatus
	readonly createdAt: number
	readonly updatedAt: number
}

export interface MemoryContent {
	readonly id: MemoryId
	readonly content: string
	readonly format: 'text' | 'markdown' | 'json'
	readonly metadata?: Record<string, unknown>
}

export interface MemorySearchParams {
	readonly query?: string
	readonly tags?: string[]
	readonly status?: MemoryStatus
	readonly limit?: number
}

export interface MemorySearchResult {
	readonly entries: readonly MemoryIndexEntry[]
	readonly totalCount: number
}

export interface CreateMemoryParams {
	readonly title: string
	readonly summary: string
	readonly content: string
	readonly tags?: string[]
	readonly format?: 'text' | 'markdown' | 'json'
	readonly metadata?: Record<string, unknown>
}

export interface MemoryStore {
	create(params: CreateMemoryParams): Promise<{ entry: MemoryIndexEntry; content: MemoryContent }>
	get(id: MemoryId): Promise<MemoryContent | undefined>
	update(id: MemoryId, updates: Partial<CreateMemoryParams>): Promise<MemoryIndexEntry | undefined>
	delete(id: MemoryId): Promise<boolean>
	list(params?: MemorySearchParams): Promise<MemorySearchResult>
}

export interface MemoryIndex {
	search(params: MemorySearchParams): MemorySearchResult
	getEntry(id: MemoryId): MemoryIndexEntry | undefined
	allEntries(): readonly MemoryIndexEntry[]
	count(): number
	rebuild(entries: MemoryIndexEntry[]): void
}
