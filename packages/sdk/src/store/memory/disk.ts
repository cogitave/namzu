import { mkdir, realpath, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { NamzuError } from '../../types/errors/index.js'
import type { MemoryId } from '../../types/ids/index.js'
import type {
	CreateMemoryParams,
	MemoryContent,
	MemoryIndexEntry,
	MemorySearchParams,
	MemorySearchResult,
	MemoryStore,
} from '../../types/memory/index.js'
import { asMemoryId, generateMemoryId } from '../../utils/id.js'
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

const SAFE_STORAGE_ID = /^mem_[A-Za-z0-9_-]+$/

interface StorageLocation {
	readonly indexPath: string
	readonly contentDir: string
}

const operationTails = new Map<string, Promise<void>>()

/** Serialize every operation over one canonical disk projection in this process. */
async function withMemoryOperationLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
	const previous = operationTails.get(key) ?? Promise.resolve()
	let release = () => {}
	const current = new Promise<void>((resolveCurrent) => {
		release = resolveCurrent
	})
	const tail = previous.then(() => current)
	operationTails.set(key, tail)

	await previous
	try {
		return await operation()
	} finally {
		release()
		if (operationTails.get(key) === tail) operationTails.delete(key)
	}
}

function invalidIndex(
	reason: string,
	details: { entryIndex?: number; field?: string } = {},
): never {
	throw new NamzuError({
		code: 'storage_error',
		message: `Memory index is invalid${
			details.entryIndex === undefined ? '' : ` at entry ${details.entryIndex}`
		}: ${reason}. Refusing to treat unreadable durable memory as empty.`,
		details,
		retryable: false,
	})
}

function invalidContent(id: string, reason: string, details: { field?: string } = {}): never {
	throw new NamzuError({
		code: 'storage_error',
		message: `Memory content for ${id} is invalid: ${reason}. Refusing to treat indexed durable memory as absent or valid.`,
		details: { id, ...details },
		retryable: false,
	})
}

/** A typed ID is not automatically a safe filesystem segment. */
function assertStorageMemoryId(
	value: unknown,
	refuse: (reason: string) => never,
): asserts value is MemoryId {
	if (typeof value !== 'string') refuse('id must be a memory ID string')
	try {
		asMemoryId(value)
	} catch {
		refuse('id must use the recognized mem_ prefix')
	}
	if (!SAFE_STORAGE_ID.test(value)) {
		refuse('id must be one cross-platform safe filename segment')
	}
}

/**
 * Validate the domain shape before anything is installed in the live index.
 *
 * `DiskRecordStore` owns the version envelope and JSON parsing; it cannot
 * know that this particular array contains memory entries. Keeping this
 * check here avoids turning the generic primitive into a schema registry,
 * while ensuring valid JSON with a wrong field type cannot be accepted and
 * later written back beside a new record.
 */
function assertMemoryIndexEntries(value: unknown): asserts value is readonly MemoryIndexEntry[] {
	if (!Array.isArray(value)) invalidIndex('the top-level value must be an array')

	const ids = new Set<string>()
	for (const [entryIndex, candidate] of value.entries()) {
		if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
			invalidIndex('each entry must be an object', { entryIndex })
		}
		const entry = candidate as Record<string, unknown>

		assertStorageMemoryId(entry.id, (reason) =>
			invalidIndex(reason, {
				entryIndex,
				field: 'id',
			}),
		)
		if (ids.has(entry.id)) {
			invalidIndex('ids must be unique', { entryIndex, field: 'id' })
		}
		ids.add(entry.id)

		for (const field of ['title', 'summary'] as const) {
			if (typeof entry[field] !== 'string') {
				invalidIndex(`${field} must be a string`, { entryIndex, field })
			}
		}
		if (!Array.isArray(entry.tags) || !entry.tags.every((tag) => typeof tag === 'string')) {
			invalidIndex('tags must be an array of strings', { entryIndex, field: 'tags' })
		}
		if (entry.status !== 'active' && entry.status !== 'archived') {
			invalidIndex('status must be active or archived', { entryIndex, field: 'status' })
		}
		for (const field of ['createdAt', 'updatedAt'] as const) {
			if (typeof entry[field] !== 'number' || !Number.isFinite(entry[field])) {
				invalidIndex(`${field} must be a finite number`, { entryIndex, field })
			}
		}
	}
}

function assertMemoryContent(value: unknown, expectedId: MemoryId): asserts value is MemoryContent {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		invalidContent(expectedId, 'the record must be an object')
	}
	const content = value as Record<string, unknown>
	assertStorageMemoryId(content.id, (reason) => invalidContent(expectedId, reason, { field: 'id' }))
	if (content.id !== expectedId) {
		invalidContent(expectedId, 'record id does not match its index owner', { field: 'id' })
	}
	if (typeof content.content !== 'string') {
		invalidContent(expectedId, 'content must be a string', { field: 'content' })
	}
	if (content.format !== 'text' && content.format !== 'markdown' && content.format !== 'json') {
		invalidContent(expectedId, 'format must be text, markdown, or json', { field: 'format' })
	}
	if (
		content.metadata !== undefined &&
		(content.metadata === null ||
			typeof content.metadata !== 'object' ||
			Array.isArray(content.metadata))
	) {
		invalidContent(expectedId, 'metadata must be an object when present', { field: 'metadata' })
	}
}

export interface DiskMemoryStoreConfig {
	baseDir: string
	logger?: Logger
}

export class DiskMemoryStore implements MemoryStore {
	private readonly baseDir: string
	private readonly log: Logger
	private readonly index = new InMemoryMemoryIndex()
	private location?: StorageLocation
	// Two instances of one primitive rather than two copies of its body.
	// Typed separately because the index file holds an ARRAY and a content
	// file holds one record, and a single `DiskRecordStore<unknown>` would
	// have put the cast back at every call site.
	private readonly records = new DiskRecordStore<unknown>(SCHEMA)
	private readonly indexRecords = new DiskRecordStore<unknown>(SCHEMA)

	constructor(config: DiskMemoryStoreConfig) {
		this.baseDir = join(config.baseDir, 'memory')
		this.log = resolveLogger(config.logger).child({ [SCOPE_ATTRIBUTE]: 'store/memory/disk' })
	}

	private get contentDir(): string {
		return join(this.baseDir, 'content')
	}

	private async storageLocation(): Promise<StorageLocation> {
		if (this.location) return this.location

		await mkdir(this.contentDir, { recursive: true })
		const [canonicalBaseDir, canonicalContentDir] = await Promise.all([
			realpath(this.baseDir),
			realpath(this.contentDir),
		])
		if (dirname(canonicalContentDir) !== canonicalBaseDir) {
			invalidIndex('the content directory resolves outside the memory store')
		}
		this.location = {
			indexPath: join(canonicalBaseDir, 'index.json'),
			contentDir: canonicalContentDir,
		}
		return this.location
	}

	private contentPath(location: StorageLocation, id: MemoryId): string {
		assertStorageMemoryId(id, (reason) => invalidContent(id, reason, { field: 'id' }))
		const path = resolve(location.contentDir, `${id}.json`)
		if (dirname(path) !== location.contentDir) {
			invalidContent(id, 'resolved path escapes the content directory', { field: 'id' })
		}
		return path
	}

	private async reloadIndex(location: StorageLocation): Promise<void> {
		try {
			const entries = await this.indexRecords.read(location.indexPath)
			if (entries === null) {
				this.index.rebuild([])
				return
			}
			assertMemoryIndexEntries(entries)
			this.index.rebuild([...entries])
			this.log.info('Memory index loaded', { 'namzu.store.count': entries.length })
		} catch (err) {
			this.log.error('Failed to read memory index — refusing to start empty', {
				'exception.message': String(err),
			})
			throw err
		}
	}

	private async withAuthoritativeIndex<T>(
		operation: (location: StorageLocation) => Promise<T>,
	): Promise<T> {
		const location = await this.storageLocation()
		return withMemoryOperationLock(location.indexPath, async () => {
			await this.reloadIndex(location)
			return operation(location)
		})
	}

	private async readContent(location: StorageLocation, id: MemoryId): Promise<MemoryContent> {
		const content = await this.records.read(this.contentPath(location, id))
		if (content === null) invalidContent(id, 'the indexed content record is missing')
		assertMemoryContent(content, id)
		return content
	}

	private async writeIndex(
		location: StorageLocation,
		entries: readonly MemoryIndexEntry[],
	): Promise<void> {
		await this.indexRecords.write(location.indexPath, entries)
	}

	async create(
		params: CreateMemoryParams,
	): Promise<{ entry: MemoryIndexEntry; content: MemoryContent }> {
		return this.withAuthoritativeIndex(async (location) => {
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
			const contentPath = this.contentPath(location, id)
			const entries = [...this.index.allEntries(), entry]

			await this.records.write(contentPath, memoryContent)
			try {
				await this.writeIndex(location, entries)
			} catch (error) {
				await unlink(contentPath).catch(() => undefined)
				throw error
			}
			this.index.rebuild(entries)

			this.log.info('Memory created', {
				'namzu.memory.id': id,
				'namzu.store.title': params.title,
			})

			return { entry, content: memoryContent }
		})
	}

	async get(id: MemoryId): Promise<MemoryContent | undefined> {
		return this.withAuthoritativeIndex(async (location) => {
			assertStorageMemoryId(id, (reason) => invalidContent(id, reason, { field: 'id' }))
			if (!this.index.getEntry(id)) return undefined
			return this.readContent(location, id)
		})
	}

	async update(
		id: MemoryId,
		updates: Partial<CreateMemoryParams>,
	): Promise<MemoryIndexEntry | undefined> {
		return this.withAuthoritativeIndex(async (location) => {
			assertStorageMemoryId(id, (reason) => invalidContent(id, reason, { field: 'id' }))
			const existing = this.index.getEntry(id)
			if (!existing) return undefined
			const existingContent = await this.readContent(location, id)
			const updated: MemoryIndexEntry = {
				...existing,
				title: updates.title ?? existing.title,
				summary: updates.summary ?? existing.summary,
				tags: updates.tags ? [...updates.tags] : existing.tags,
				updatedAt: Date.now(),
			}
			const updatesContent =
				updates.content !== undefined ||
				updates.format !== undefined ||
				updates.metadata !== undefined
			if (updatesContent) {
				const updatedContent: MemoryContent = {
					...existingContent,
					content: updates.content ?? existingContent.content,
					format: updates.format ?? existingContent.format,
					metadata:
						updates.metadata !== undefined ? { ...updates.metadata } : existingContent.metadata,
				}
				await this.records.write(this.contentPath(location, id), updatedContent)
			}

			const entries = this.index.allEntries().map((entry) => (entry.id === id ? updated : entry))
			await this.writeIndex(location, entries)
			this.index.rebuild([...entries])

			this.log.info('Memory updated', { 'namzu.memory.id': id })
			return updated
		})
	}

	async delete(id: MemoryId): Promise<boolean> {
		return this.withAuthoritativeIndex(async (location) => {
			assertStorageMemoryId(id, (reason) => invalidContent(id, reason, { field: 'id' }))
			if (!this.index.getEntry(id)) return false

			try {
				await unlink(this.contentPath(location, id))
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
			}
			const entries = this.index.allEntries().filter((entry) => entry.id !== id)
			await this.writeIndex(location, entries)
			this.index.rebuild([...entries])

			this.log.info('Memory deleted', { 'namzu.memory.id': id })
			return true
		})
	}

	async list(params?: MemorySearchParams): Promise<MemorySearchResult> {
		return this.withAuthoritativeIndex(async () => this.index.search(params ?? {}))
	}

	getIndex(): InMemoryMemoryIndex {
		return this.index
	}
}
