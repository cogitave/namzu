import type { MemoryId } from '../../types/ids/index.js'
import type {
	CreateMemoryParams,
	MemoryContent,
	MemoryIndexEntry,
	MemoryRecord,
	MemorySearchParams,
	MemorySearchResult,
	MemoryStore,
	UpdateMemoryParams,
} from '../../types/memory/index.js'
import { assertMemoryStatus } from '../../types/memory/index.js'
import { generateMemoryId } from '../../utils/id.js'
import { InMemoryMemoryIndex, searchMemoryEntries } from './index.js'

export class InMemoryMemoryStore implements MemoryStore {
	private content = new Map<string, MemoryContent>()
	private index = new InMemoryMemoryIndex()

	async create(
		params: CreateMemoryParams,
	): Promise<{ entry: MemoryIndexEntry; content: MemoryContent }> {
		const id = generateMemoryId()
		const now = Date.now()

		const entry: MemoryIndexEntry = {
			id,
			title: params.title,
			summary: params.summary,
			tags: params.tags ? [...params.tags] : [],
			status: 'active',
			createdAt: now,
			updatedAt: now,
		}

		const memoryContent: MemoryContent = {
			id,
			content: params.content,
			format: params.format ?? 'text',
			metadata: params.metadata ? { ...params.metadata } : undefined,
		}

		this.index.set(entry)
		this.content.set(id, memoryContent)

		return { entry, content: memoryContent }
	}

	async get(id: MemoryId): Promise<MemoryContent | undefined> {
		return this.content.get(id)
	}

	async getRecord(id: MemoryId): Promise<MemoryRecord | undefined> {
		const entry = this.index.getEntry(id)
		const content = this.content.get(id)
		return entry && content ? structuredClone({ entry, content }) : undefined
	}

	async update(id: MemoryId, updates: UpdateMemoryParams): Promise<MemoryIndexEntry | undefined> {
		if (updates.status !== undefined) assertMemoryStatus(updates.status)
		const existing = this.index.getEntry(id)
		if (!existing) return undefined

		const now = Date.now()

		const updated: MemoryIndexEntry = {
			...existing,
			title: updates.title ?? existing.title,
			summary: updates.summary ?? existing.summary,
			tags: updates.tags ? [...updates.tags] : existing.tags,
			status: updates.status ?? existing.status,
			updatedAt: now,
		}

		this.index.set(updated)

		if (
			updates.content !== undefined ||
			updates.format !== undefined ||
			updates.metadata !== undefined
		) {
			const existingContent = this.content.get(id)
			if (existingContent) {
				const updatedContent: MemoryContent = {
					...existingContent,
					content: updates.content ?? existingContent.content,
					format: updates.format ?? existingContent.format,
					metadata:
						updates.metadata !== undefined ? { ...updates.metadata } : existingContent.metadata,
				}
				this.content.set(id, updatedContent)
			}
		}

		return updated
	}

	async delete(id: MemoryId): Promise<boolean> {
		const existed = this.index.remove(id)
		this.content.delete(id)
		return existed
	}

	async list(params?: MemorySearchParams): Promise<MemorySearchResult> {
		return searchMemoryEntries(
			this.index.allEntries(),
			params ?? {},
			(id) => this.content.get(id)?.content ?? '',
		)
	}

	getIndex(): InMemoryMemoryIndex {
		return this.index
	}
}
