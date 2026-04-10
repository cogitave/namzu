import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
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
import { type Logger, getRootLogger } from '../../utils/logger.js'
import { InMemoryMemoryIndex } from './index.js'

export interface DiskMemoryStoreConfig {
	baseDir: string
	logger?: Logger
}

export class DiskMemoryStore implements MemoryStore {
	private baseDir: string
	private log: Logger
	private index = new InMemoryMemoryIndex()
	private initialized = false

	constructor(config: DiskMemoryStoreConfig) {
		this.baseDir = join(config.baseDir, 'memory')
		this.log = (config.logger ?? getRootLogger()).child({ component: 'DiskMemoryStore' })
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
			const raw = await readFile(this.indexPath, 'utf-8')
			const entries = JSON.parse(raw) as MemoryIndexEntry[]
			this.index.rebuild(entries)
			this.log.info('Memory index loaded', { count: entries.length })
		} catch (err) {
			const isNotFound =
				typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT'
			if (!isNotFound) {
				this.log.warn('Failed to read memory index — starting fresh', {
					error: String(err),
				})
			}
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
		await atomicWriteJson(this.contentPath(id), memoryContent)

		this.log.info('Memory created', { memoryId: id, title: params.title })

		return { entry, content: memoryContent }
	}

	async get(id: MemoryId): Promise<MemoryContent | undefined> {
		await this.ensureInit()

		if (!this.index.getEntry(id)) return undefined

		try {
			const raw = await readFile(this.contentPath(id), 'utf-8')
			return JSON.parse(raw) as MemoryContent
		} catch {
			this.log.warn('Failed to read memory content', { memoryId: id })
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
				const raw = await readFile(this.contentPath(id), 'utf-8')
				const existingContent = JSON.parse(raw) as MemoryContent

				const updatedContent: MemoryContent = {
					...existingContent,
					content: updates.content ?? existingContent.content,
					format: updates.format ?? existingContent.format,
					metadata:
						updates.metadata !== undefined ? { ...updates.metadata } : existingContent.metadata,
				}

				await atomicWriteJson(this.contentPath(id), updatedContent)
			} catch {
				this.log.warn('Failed to update memory content', { memoryId: id })
			}
		}

		this.log.info('Memory updated', { memoryId: id })
		return updated
	}

	async delete(id: MemoryId): Promise<boolean> {
		await this.ensureInit()

		const existed = this.index.remove(id)
		if (!existed) return false

		await this.persistIndex()
		await unlink(this.contentPath(id)).catch(() => undefined)

		this.log.info('Memory deleted', { memoryId: id })
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
		await atomicWriteJson(this.indexPath, entries)
	}
}

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
	const tempPath = `${filePath}.tmp`
	try {
		await writeFile(tempPath, content, 'utf-8')
		await rename(tempPath, filePath)
	} catch (err) {
		await unlink(tempPath).catch(() => undefined)
		throw err
	}
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
	await atomicWriteFile(filePath, JSON.stringify(value, null, 2))
}
