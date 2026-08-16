import { mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
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
import { SCOPE_ATTRIBUTE } from '../../utils/log/types.js'
import { type Logger, resolveLogger } from '../../utils/logger.js'
import { DiskRecordStore } from '../kv/record-store.js'
import { defineSchema } from '../schema.js'
import { InMemoryMemoryIndex } from './index.js'

/**
 * This store's on-disk format, versioned as a unit — which is how a
 * migration would actually be written and shipped, and it keeps every call
 * site free of schema plumbing.
 *
 * Bump `current` and add the migration for the step you are leaving when
 * the shape changes.
 */
const SCHEMA = defineSchema({ kind: 'memory-store', current: 1, migrations: {} })

export interface DiskMemoryStoreConfig {
	baseDir: string
	logger?: Logger
}

export class DiskMemoryStore implements MemoryStore {
	private baseDir: string
	private log: Logger
	private index = new InMemoryMemoryIndex()
	private initialized = false
	// Two instances of one primitive rather than two copies of its body.
	// Typed separately because the index file holds an ARRAY and a content
	// file holds one record, and a single `DiskRecordStore<unknown>` would
	// have put the cast back at every call site.
	private readonly records = new DiskRecordStore<MemoryContent>(SCHEMA)
	private readonly indexRecords = new DiskRecordStore<readonly MemoryIndexEntry[]>(SCHEMA)

	constructor(config: DiskMemoryStoreConfig) {
		this.baseDir = join(config.baseDir, 'memory')
		this.log = resolveLogger(config.logger).child({ [SCOPE_ATTRIBUTE]: 'store/memory/disk' })
	}

	private get indexPath(): string {
		return join(this.baseDir, 'index.json')
	}

	private get contentDir(): string {
		return join(this.baseDir, 'content')
	}

	private contentPath(id: MemoryId): string {
		return join(this.contentDir, `${id}.json`)
	}

	private async ensureInit(): Promise<void> {
		if (this.initialized) return

		await mkdir(this.contentDir, { recursive: true })

		try {
			// `null` for "no index yet", which is an ordinary first-run state
			// and not something to warn about. The catch below is now only
			// for a real IO or parse failure — the distinction this method
			// used to draw by hand with an ENOENT comparison.
			const entries = await this.indexRecords.read(this.indexPath)
			if (entries !== null) {
				this.index.rebuild([...entries])
				this.log.info('Memory index loaded', { 'namzu.store.count': entries.length })
			}
		} catch (err) {
			this.log.warn('Failed to read memory index — starting fresh', {
				'exception.message': String(err),
			})
		}

		this.initialized = true
	}

	async create(
		params: CreateMemoryParams,
	): Promise<{ entry: MemoryIndexEntry; content: MemoryContent }> {
		await this.ensureInit()

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
		await this.persistIndex()
		await this.records.write(this.contentPath(id), memoryContent)

		this.log.info('Memory created', { 'namzu.memory.id': id, 'namzu.store.title': params.title })

		return { entry, content: memoryContent }
	}

	async get(id: MemoryId): Promise<MemoryContent | undefined> {
		await this.ensureInit()

		if (!this.index.getEntry(id)) return undefined

		try {
			return (await this.records.read(this.contentPath(id))) ?? undefined
		} catch {
			this.log.warn('Failed to read memory content', { 'namzu.memory.id': id })
			return undefined
		}
	}

	async update(
		id: MemoryId,
		updates: Partial<CreateMemoryParams>,
	): Promise<MemoryIndexEntry | undefined> {
		await this.ensureInit()

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
		await this.persistIndex()

		if (
			updates.content !== undefined ||
			updates.format !== undefined ||
			updates.metadata !== undefined
		) {
			try {
				const existingContent = await this.records.read(this.contentPath(id))
				if (existingContent === null) throw new Error('memory content is missing')

				const updatedContent: MemoryContent = {
					...existingContent,
					content: updates.content ?? existingContent.content,
					format: updates.format ?? existingContent.format,
					metadata:
						updates.metadata !== undefined ? { ...updates.metadata } : existingContent.metadata,
				}

				await this.records.write(this.contentPath(id), updatedContent)
			} catch {
				this.log.warn('Failed to update memory content', { 'namzu.memory.id': id })
			}
		}

		this.log.info('Memory updated', { 'namzu.memory.id': id })
		return updated
	}

	async delete(id: MemoryId): Promise<boolean> {
		await this.ensureInit()

		const existed = this.index.remove(id)
		if (!existed) return false

		await this.persistIndex()
		await unlink(this.contentPath(id)).catch(() => undefined)

		this.log.info('Memory deleted', { 'namzu.memory.id': id })
		return true
	}

	async list(params?: MemorySearchParams): Promise<MemorySearchResult> {
		await this.ensureInit()
		return this.index.search(params ?? {})
	}

	getIndex(): InMemoryMemoryIndex {
		return this.index
	}

	private async persistIndex(): Promise<void> {
		const entries = this.index.allEntries()
		await this.indexRecords.write(this.indexPath, entries)
	}
}
