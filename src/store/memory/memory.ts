import type { MemoryId } from '../../types/ids/index.js'
import type {
	CreateMemoryParams,
	MemoryContent,
	MemoryIndexEntry,
	MemorySearchParams,
	MemorySearchResult,
	MemoryStore,
} from '../../types/memory/index.js'
import { generateMemoryId } from '../../utils/id.js'
import { InMemoryMemoryIndex } from './index.js'

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

	async update(
		id: MemoryId,
		updates: Partial<CreateMemoryParams>,
	): Promise<MemoryIndexEntry | undefined> {
		const existing = this.index.getEntry(id)
		if (!existing) return undefined

		const now = Date.now()

		const updated: MemoryIndexEntry = {
			...existing,
			title: updates.title ?? existing.title,
			summary: updates.summary ?? existing.summary,
			tags: updates.tags ? [...updates.tags] : existing.tags,
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
		return this.index.search(params ?? {})
	}

	getIndex(): InMemoryMemoryIndex {
		return this.index
	}
}
