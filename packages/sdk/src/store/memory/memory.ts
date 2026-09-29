import type { MemoryId } from '../../types/ids/index.js'
import type {
	ConditionalMemoryStore,
	CreateMemoryParams,
	MemoryContent,
	MemoryIndexEntry,
	MemoryRecord,
	MemorySearchParams,
	MemorySearchResult,
	UpdateMemoryParams,
	VersionedMemoryRecord,
} from '../../types/memory/index.js'
import { assertMemoryStatus } from '../../types/memory/index.js'
import { generateMemoryId } from '../../utils/id.js'
import { InMemoryMemoryIndex, searchMemoryEntries } from './index.js'
import {
	MemoryNameConflictError,
	assertOptionalMemoryFields,
	nameHolder,
	withOptionalFields,
} from './naming.js'
import { assertMemoryRevision, memoryRevision } from './revision.js'

export class InMemoryMemoryStore implements ConditionalMemoryStore {
	private content = new Map<string, MemoryContent>()
	private index = new InMemoryMemoryIndex()

	async create(
		params: CreateMemoryParams,
	): Promise<{ entry: MemoryIndexEntry; content: MemoryContent }> {
		assertOptionalMemoryFields(params)
		if (params.name !== undefined) {
			const holder = nameHolder(this.index.allEntries(), params.name)
			if (holder) throw new MemoryNameConflictError(params.name, holder.id)
		}
		const id = generateMemoryId()
		const now = Date.now()

		const entry: MemoryIndexEntry = withOptionalFields(
			{
				id,
				title: params.title,
				summary: params.summary,
				tags: params.tags ? [...params.tags] : [],
				status: 'active',
				createdAt: now,
				updatedAt: now,
			},
			params,
		)

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

	async getVersionedRecord(id: MemoryId): Promise<VersionedMemoryRecord | undefined> {
		const entry = this.index.getEntry(id)
		const content = this.content.get(id)
		if (!entry || !content) return undefined
		const record = structuredClone({ entry, content })
		return { ...record, revision: memoryRevision(record) }
	}

	async update(id: MemoryId, updates: UpdateMemoryParams): Promise<MemoryIndexEntry | undefined> {
		return this.updateNow(id, updates)
	}

	async updateIfRevision(
		id: MemoryId,
		updates: UpdateMemoryParams,
		expectedRevision: string,
	): Promise<MemoryIndexEntry> {
		// No await between the check and mutation: one in-memory operation turn.
		const entry = this.updateNow(id, updates, expectedRevision)
		if (!entry) throw new Error('A conditional memory update unexpectedly found no record.')
		return entry
	}

	private updateNow(
		id: MemoryId,
		updates: UpdateMemoryParams,
		expectedRevision?: string,
	): MemoryIndexEntry | undefined {
		if (updates.status !== undefined) assertMemoryStatus(updates.status)
		assertOptionalMemoryFields(updates)
		const existing = this.index.getEntry(id)
		if (expectedRevision !== undefined) {
			const content = this.content.get(id)
			assertMemoryRevision(
				id,
				existing && content ? { entry: existing, content } : undefined,
				expectedRevision,
			)
		}
		if (!existing) return undefined
		if (updates.name !== undefined) {
			const holder = nameHolder(this.index.allEntries(), updates.name, id)
			if (holder) throw new MemoryNameConflictError(updates.name, holder.id)
		}

		const now = Date.now()

		const updated: MemoryIndexEntry = withOptionalFields(
			{
				...existing,
				title: updates.title ?? existing.title,
				summary: updates.summary ?? existing.summary,
				tags: updates.tags ? [...updates.tags] : existing.tags,
				status: updates.status ?? existing.status,
				updatedAt: now,
			},
			updates,
		)

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
		return this.deleteNow(id)
	}

	async deleteIfRevision(id: MemoryId, expectedRevision: string): Promise<void> {
		this.deleteNow(id, expectedRevision)
	}

	private deleteNow(id: MemoryId, expectedRevision?: string): boolean {
		if (expectedRevision !== undefined) {
			const entry = this.index.getEntry(id)
			const content = this.content.get(id)
			assertMemoryRevision(id, entry && content ? { entry, content } : undefined, expectedRevision)
		}
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
