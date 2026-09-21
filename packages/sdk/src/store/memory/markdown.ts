import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { NamzuError } from '../../types/errors/index.js'
import type { MemoryId } from '../../types/ids/index.js'
import type {
	CreateMemoryParams,
	MemoryContent,
	MemoryIndexEntry,
	MemoryRecord,
	MemorySearchParams,
	MemorySearchResult,
	MemoryStore,
	MemoryType,
	UpdateMemoryParams,
} from '../../types/memory/index.js'
import { assertMemoryStatus, isMemoryType } from '../../types/memory/index.js'
import { atomicWriteFile } from '../../utils/atomic-write.js'
import { generateMemoryId, isEntityId } from '../../utils/id.js'
import { SCOPE_ATTRIBUTE } from '../../utils/log/types.js'
import { type Logger, resolveLogger } from '../../utils/logger.js'
import { defineSchema, migrate } from '../schema.js'
import {
	MEMORY_INDEX_FILE_HEADER,
	type RenderedMemoryIndex,
	renderMemoryIndex,
} from './index-file.js'
import { searchMemoryEntries } from './index.js'
import {
	type FrontmatterJson,
	MemoryFileFormatError,
	formatMemoryFile,
	parseMemoryFile,
} from './markdown-format.js'
import {
	MemoryNameConflictError,
	assertOptionalMemoryFields,
	isMemoryName,
	nameHolder,
	slugifyMemoryName,
	uniqueMemoryName,
} from './naming.js'
import {
	DEFAULT_MEMORY_LOCK_TIMEOUT_MS,
	acquireMemoryOperationLock,
	validateMemoryLockTimeout,
} from './operation-lock.js'

/**
 * Versioned like every other record this SDK persists. A memory file carries
 * no `schemaVersion` while it is at version 1 — the reference shape has no
 * such field and a hand-written file should not need one — so the stamp only
 * appears once a later build writes a later version, and THIS build refuses
 * that file rather than reading it partially and writing the difference away.
 */
const SCHEMA = defineSchema({
	kind: 'markdown-memory',
	current: 1,
	migrations: {},
})

/** A `DiskMemoryStore` index; its presence means records this store cannot see. */
const LEGACY_INDEX_FILE = 'index.json'
/** The generated index. Never a memory, never read back as one. */
export const MEMORY_INDEX_FILE = 'MEMORY.md'
/** Largest memory file this store will read. A memory is a paragraph, not a document. */
export const MEMORY_FILE_MAX_BYTES = 256 * 1024
const FILE_MODE = 0o600
const DIRECTORY_MODE = 0o700

export interface MarkdownMemoryStoreConfig {
	/**
	 * The exact directory holding one `<name>.md` per memory and the generated
	 * `MEMORY.md`. Created private (0700) when absent. The host owns isolation:
	 * bind it to the project or tenant the memories belong to.
	 */
	readonly directory: string
	readonly logger?: Logger
	/** Maximum wait for another process's operation; default 10 seconds. Never breaks stale locks. */
	readonly lockTimeoutMs?: number
}

/** What {@link MarkdownMemoryStore.importRecord} did with one record. */
export type MemoryImportOutcome = 'imported' | 'present'

interface LoadedMemory {
	readonly entry: MemoryIndexEntry
	readonly content: MemoryContent
	readonly path: string
}

type Loaded = ReadonlyMap<MemoryId, LoadedMemory>

function invalidFile(file: string, reason: string, cause?: unknown): never {
	throw new NamzuError({
		code: 'storage_error',
		message: `Memory file ${file} is invalid: ${reason}. Refusing to treat unreadable durable memory as absent; repair or move the file.`,
		details: { file },
		retryable: false,
		...(cause !== undefined ? { cause } : {}),
	})
}

/**
 * A stable id for a hand-written file that has none, derived from its name,
 * so reading the file twice yields the same id without writing to it. The
 * next update writes the id down, after which a rename keeps it.
 */
function derivedMemoryId(name: string): MemoryId {
	const hex = createHash('sha256').update(`namzu-memory-name:${name}`).digest('hex')
	const variant = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16)
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}` as MemoryId
}

function oneLine(text: string, limit = 150): string {
	const line = (text.split(/\r?\n/).find((part) => part.trim()) ?? '').replace(/\s+/g, ' ').trim()
	if (line.length <= limit) return line
	let head = line.slice(0, limit - 1)
	if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1)
	return `${head.trimEnd()}…`
}

function timestamp(
	value: FrontmatterJson | undefined,
	fallback: number,
	file: string,
	key: string,
): number {
	if (value === undefined) return fallback
	const parsed =
		typeof value === 'number'
			? value
			: typeof value === 'string'
				? /^\d+$/.test(value)
					? Number(value)
					: Date.parse(value)
				: Number.NaN
	if (!Number.isFinite(parsed))
		invalidFile(file, `${key} must be an ISO date or epoch milliseconds`)
	return parsed
}

function text(value: FrontmatterJson | undefined, file: string, key: string): string | undefined {
	if (value === undefined) return undefined
	if (typeof value !== 'string') invalidFile(file, `${key} must be a string`)
	return value
}

/**
 * Decode one file into the store's record, or refuse it. Every field the
 * reference shape requires — name, description, type — is required here; the
 * rest have the defaults a hand-written file would expect.
 */
function decodeMemoryFile(
	raw: string,
	file: string,
	fileName: string,
	mtimeMs: number,
): { entry: MemoryIndexEntry; content: MemoryContent } {
	let parsed: ReturnType<typeof parseMemoryFile>
	try {
		parsed = parseMemoryFile(raw, file)
	} catch (error) {
		if (error instanceof MemoryFileFormatError) {
			invalidFile(file, `${error.reason}${error.line === undefined ? '' : ` (line ${error.line})`}`)
		}
		throw error
	}
	const v = parsed.values
	// Through the schema, never around it: a file stamped by a newer build is refused.
	const stamped = v.get('schemaVersion')
	try {
		migrate(SCHEMA, {
			schemaVersion:
				typeof stamped === 'string' && /^\d+$/.test(stamped) ? Number(stamped) : stamped,
		})
	} catch (error) {
		invalidFile(file, error instanceof Error ? error.message : String(error), error)
	}

	const name = text(v.get('name'), file, 'name')
	if (!isMemoryName(name))
		invalidFile(file, 'name must be a kebab-case slug (lowercase letters, digits, hyphens)')
	if (`${name}.md` !== fileName) invalidFile(file, `name "${name}" does not match the file name`)
	const description = text(v.get('description'), file, 'description')
	if (description === undefined) invalidFile(file, 'description is required')
	if (/[\r\n]/.test(description)) invalidFile(file, 'description must be one line')
	const type = v.get('type')
	if (!isMemoryType(type)) invalidFile(file, 'type must be user, feedback, project or reference')
	const status = v.get('status') ?? 'active'
	if (status !== 'active' && status !== 'archived')
		invalidFile(file, 'status must be active or archived')
	const rawTags = v.get('tags')
	const tags =
		rawTags === undefined || rawTags === ''
			? []
			: Array.isArray(rawTags) && rawTags.every((tag) => typeof tag === 'string')
				? (rawTags as string[])
				: invalidFile(file, 'tags must be a list of strings')
	const rawId = v.get('id')
	const id = rawId === undefined ? derivedMemoryId(name) : rawId
	if (!isEntityId(id, 'memory')) invalidFile(file, 'id must be a UUID')
	const format = v.get('format') ?? 'markdown'
	if (format !== 'text' && format !== 'markdown' && format !== 'json') {
		invalidFile(file, 'format must be text, markdown or json')
	}
	const metadata = v.get('metadata')
	if (
		metadata !== undefined &&
		(metadata === null || typeof metadata !== 'object' || Array.isArray(metadata))
	) {
		invalidFile(file, 'metadata must be a JSON object')
	}
	const createdAt = timestamp(v.get('createdAt'), mtimeMs, file, 'createdAt')
	const updatedAt = timestamp(v.get('updatedAt'), mtimeMs, file, 'updatedAt')

	return {
		entry: {
			id,
			name,
			description,
			type,
			title: text(v.get('title'), file, 'title') ?? name,
			summary: text(v.get('summary'), file, 'summary') ?? description,
			tags,
			status,
			createdAt,
			updatedAt,
		},
		content: {
			id,
			content: parsed.body,
			format,
			...(metadata !== undefined ? { metadata: metadata as Record<string, unknown> } : {}),
		},
	}
}

/**
 * One Markdown file per memory, in a directory the operator can read, grep
 * and edit by hand, with a generated `MEMORY.md` index beside them.
 *
 * Implements the same {@link MemoryStore} contract as `DiskMemoryStore` and
 * keeps its guarantees: every operation — reads included — runs under the
 * directory's exclusive operation lock and reloads what is on disk, so no
 * process acts on another's stale snapshot; writes are atomic renames of
 * private (0600) files; a file that does not parse, a name that does not match
 * its file, a symlink, two files claiming one id, or a record stamped by a
 * newer build is refused with the file named, never skipped. A store that
 * quietly dropped the one file it could not read would present the model an
 * incomplete memory as a complete one.
 *
 * Names are unique. {@link create} refuses an explicit name another memory
 * holds with {@link MemoryNameConflictError}, and derives a free one from the
 * title when none is given.
 */
export class MarkdownMemoryStore implements MemoryStore {
	private readonly directory: string
	private readonly log: Logger
	private readonly lockTimeoutMs: number
	private canonical?: string

	constructor(config: MarkdownMemoryStoreConfig) {
		this.directory = resolve(config.directory)
		this.log = resolveLogger(config.logger).child({
			[SCOPE_ATTRIBUTE]: 'store/memory/markdown',
		})
		this.lockTimeoutMs = config.lockTimeoutMs ?? DEFAULT_MEMORY_LOCK_TIMEOUT_MS
		validateMemoryLockTimeout(this.lockTimeoutMs)
	}

	/** The directory this store reads and writes, as configured. */
	get path(): string {
		return this.directory
	}

	private async location(): Promise<string> {
		if (this.canonical) return this.canonical
		await mkdir(this.directory, { recursive: true, mode: DIRECTORY_MODE })
		this.canonical = await realpath(this.directory)
		return this.canonical
	}

	private memoryPath(dir: string, name: string): string {
		if (!isMemoryName(name)) invalidFile(join(dir, `${name}.md`), 'name is not a memory name')
		const path = resolve(dir, `${name}.md`)
		if (dirname(path) !== dir) invalidFile(path, 'resolved path escapes the memory directory')
		return path
	}

	private async load(dir: string, importing: boolean): Promise<Loaded> {
		const loaded = new Map<MemoryId, LoadedMemory>()
		const names = await readdir(dir)
		names.sort()
		// A `DiskMemoryStore` index in the same directory holds records this
		// store cannot see. Answering without them would present a smaller
		// memory as the whole of it, so everything but the import that moves
		// them in is refused until the index is gone.
		if (!importing && names.includes(LEGACY_INDEX_FILE)) {
			invalidFile(
				join(dir, LEGACY_INDEX_FILE),
				'a JSON memory store has not been migrated out of this directory; import its records with importRecord, then move index.json aside',
			)
		}
		for (const fileName of names) {
			if (!fileName.endsWith('.md') || fileName === MEMORY_INDEX_FILE) continue
			const path = join(dir, fileName)
			const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
				if (error.code === 'ENOENT') return undefined
				throw error
			})
			if (!stat) continue
			if (stat.isSymbolicLink()) invalidFile(path, 'a memory file must not be a symlink')
			if (!stat.isFile()) invalidFile(path, 'a memory file must be a regular file')
			if (stat.size > MEMORY_FILE_MAX_BYTES) {
				invalidFile(path, `larger than the ${MEMORY_FILE_MAX_BYTES}-byte memory file limit`)
			}
			const bytes = await readFile(path)
			let raw: string
			try {
				raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
			} catch {
				invalidFile(path, 'not valid UTF-8')
			}
			if (raw.includes('\0')) invalidFile(path, 'contains NUL bytes')
			const record = decodeMemoryFile(raw, path, fileName, stat.mtimeMs)
			const other = loaded.get(record.entry.id)
			if (other) invalidFile(path, `claims id ${record.entry.id}, which ${other.path} also claims`)
			loaded.set(record.entry.id, { ...record, path })
		}
		return loaded
	}

	private async withLoaded<T>(
		operation: (dir: string, loaded: Loaded) => Promise<T>,
		importing = false,
	): Promise<T> {
		const dir = await this.location()
		const release = await acquireMemoryOperationLock(
			join(dir, 'operation.lock'),
			this.lockTimeoutMs,
		)
		try {
			return await operation(dir, await this.load(dir, importing))
		} finally {
			await release()
		}
	}

	private async writeMemory(
		dir: string,
		entry: MemoryIndexEntry,
		content: MemoryContent,
	): Promise<string> {
		const name = entry.name ?? ''
		const path = this.memoryPath(dir, name)
		await atomicWriteFile(
			path,
			formatMemoryFile(
				{
					name,
					description: entry.description ?? oneLine(entry.summary),
					type: entry.type ?? 'project',
					status: entry.status,
					createdAt: entry.createdAt,
					updatedAt: entry.updatedAt,
					tags: entry.tags,
					id: entry.id,
					title: entry.title,
					summary: entry.summary,
					format: content.format,
					...(content.metadata !== undefined ? { metadata: content.metadata } : {}),
				},
				content.content,
			),
			{ mode: FILE_MODE },
		)
		return path
	}

	/** Rewrite `MEMORY.md` from `entries` when its text would change. */
	private async writeIndex(dir: string, entries: readonly MemoryIndexEntry[]): Promise<void> {
		const { text } = renderMemoryIndex(entries, {
			maxLines: Number.POSITIVE_INFINITY,
		})
		const next = `${MEMORY_INDEX_FILE_HEADER}\n${text ? `${text}\n` : ''}`
		const path = join(dir, MEMORY_INDEX_FILE)
		const current = await readFile(path, 'utf-8').catch(() => undefined)
		if (current !== next) await atomicWriteFile(path, next, { mode: FILE_MODE })
	}

	private entries(loaded: Loaded): MemoryIndexEntry[] {
		return [...loaded.values()].map((memory) => memory.entry)
	}

	async create(
		params: CreateMemoryParams,
	): Promise<{ entry: MemoryIndexEntry; content: MemoryContent }> {
		assertOptionalMemoryFields(params)
		return this.withLoaded(async (dir, loaded) => {
			const entries = this.entries(loaded)
			let name: string
			if (params.name !== undefined) {
				const holder = nameHolder(entries, params.name)
				if (holder) throw new MemoryNameConflictError(params.name, holder.id)
				name = params.name
			} else {
				name = uniqueMemoryName(
					slugifyMemoryName(params.title),
					new Set(entries.flatMap((entry) => (entry.name ? [entry.name] : []))),
				)
			}
			const id = generateMemoryId()
			const now = Date.now()
			const entry: MemoryIndexEntry = {
				id,
				name,
				description: params.description ?? oneLine(params.summary),
				type: params.type ?? 'project',
				title: params.title,
				summary: params.summary,
				tags: params.tags ? [...params.tags] : [],
				status: 'active',
				createdAt: now,
				updatedAt: now,
			}
			const content: MemoryContent = {
				id,
				content: params.content,
				format: params.format ?? 'markdown',
				...(params.metadata ? { metadata: { ...params.metadata } } : {}),
			}
			const path = await this.writeMemory(dir, entry, content)
			try {
				await this.writeIndex(dir, [...entries, entry])
			} catch (error) {
				// The memory is written and readable; only the generated index is
				// behind, and the next write rebuilds it from the files.
				this.log.warn('Memory index was not regenerated', {
					'namzu.memory.id': id,
					'exception.message': String(error),
				})
			}
			this.log.info('Memory created', {
				'namzu.memory.id': id,
				'namzu.store.path': path,
			})
			return structuredClone({ entry, content })
		})
	}

	async get(id: MemoryId): Promise<MemoryContent | undefined> {
		return (await this.getRecord(id))?.content
	}

	async getRecord(id: MemoryId): Promise<MemoryRecord | undefined> {
		return this.withLoaded(async (_dir, loaded) => {
			const memory = loaded.get(id)
			return memory ? structuredClone({ entry: memory.entry, content: memory.content }) : undefined
		})
	}

	/** The current record held under `name`, archived included, or `undefined`. */
	async getByName(name: string): Promise<MemoryRecord | undefined> {
		return this.withLoaded(async (_dir, loaded) => {
			for (const memory of loaded.values()) {
				if (memory.entry.name === name) {
					return structuredClone({
						entry: memory.entry,
						content: memory.content,
					})
				}
			}
			return undefined
		})
	}

	async update(id: MemoryId, updates: UpdateMemoryParams): Promise<MemoryIndexEntry | undefined> {
		if (updates.status !== undefined) assertMemoryStatus(updates.status)
		assertOptionalMemoryFields(updates)
		return this.withLoaded(async (dir, loaded) => {
			const existing = loaded.get(id)
			if (!existing) return undefined
			const entries = this.entries(loaded)
			if (updates.name !== undefined) {
				const holder = nameHolder(entries, updates.name, id)
				if (holder) throw new MemoryNameConflictError(updates.name, holder.id)
			}
			const entry: MemoryIndexEntry = {
				...existing.entry,
				name: updates.name ?? existing.entry.name,
				description: updates.description ?? existing.entry.description,
				type: updates.type ?? existing.entry.type,
				title: updates.title ?? existing.entry.title,
				summary: updates.summary ?? existing.entry.summary,
				tags: updates.tags ? [...updates.tags] : existing.entry.tags,
				status: updates.status ?? existing.entry.status,
				updatedAt: Date.now(),
			}
			const content: MemoryContent = {
				...existing.content,
				content: updates.content ?? existing.content.content,
				format: updates.format ?? existing.content.format,
				...(updates.metadata !== undefined ? { metadata: { ...updates.metadata } } : {}),
			}
			const path = await this.writeMemory(dir, entry, content)
			// A rename writes the new file before removing the old one. A crash
			// between the two leaves both claiming this id, which the next load
			// refuses by name — visible, where the other order could lose it.
			if (path !== existing.path) await unlink(existing.path)
			await this.writeIndex(
				dir,
				entries.map((candidate) => (candidate.id === id ? entry : candidate)),
			)
			this.log.info('Memory updated', { 'namzu.memory.id': id })
			return structuredClone(entry)
		})
	}

	async delete(id: MemoryId): Promise<boolean> {
		return this.withLoaded(async (dir, loaded) => {
			const existing = loaded.get(id)
			if (!existing) return false
			try {
				await unlink(existing.path)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
			}
			await this.writeIndex(
				dir,
				this.entries(loaded).filter((entry) => entry.id !== id),
			)
			this.log.info('Memory deleted', { 'namzu.memory.id': id })
			return true
		})
	}

	async list(params?: MemorySearchParams): Promise<MemorySearchResult> {
		return this.withLoaded(async (_dir, loaded) =>
			structuredClone(
				searchMemoryEntries(
					this.entries(loaded),
					params ?? {},
					(id) => loaded.get(id)?.content.content ?? '',
				),
			),
		)
	}

	/**
	 * The index a prompt carries: one line per active memory, capped at
	 * `maxLines` (default 200) with a note pointing to search for the rest.
	 * Rendered from the memory files under the lock, so it is current even
	 * when a file was edited by hand since the last write.
	 */
	async readIndex(options: { readonly maxLines?: number } = {}): Promise<RenderedMemoryIndex> {
		return this.withLoaded(async (_dir, loaded) => renderMemoryIndex(this.entries(loaded), options))
	}

	/**
	 * Bring in a record from another store, keeping its id, timestamps,
	 * status and metadata. Idempotent by id: a record already here is left
	 * alone and reported `present`, so a migration interrupted halfway can
	 * simply run again. A name another memory holds is suffixed rather than
	 * refused, because an import that stopped on a clash would strand the
	 * records after it.
	 */
	async importRecord(
		record: MemoryRecord,
		defaults: { readonly type?: MemoryType } = {},
	): Promise<MemoryImportOutcome> {
		assertOptionalMemoryFields(record.entry)
		if (!isEntityId(record.entry.id, 'memory')) {
			throw new NamzuError({
				code: 'invalid_config',
				message: 'An imported memory must carry a UUID id.',
				retryable: false,
			})
		}
		if (record.content.id !== record.entry.id) {
			throw new NamzuError({
				code: 'invalid_config',
				message: 'An imported memory record has a content id that does not match its entry.',
				retryable: false,
			})
		}
		return this.withLoaded(async (dir, loaded) => {
			if (loaded.has(record.entry.id)) return 'present'
			const entries = this.entries(loaded)
			const taken = new Set(entries.flatMap((entry) => (entry.name ? [entry.name] : [])))
			const name = uniqueMemoryName(
				record.entry.name ?? slugifyMemoryName(record.entry.title),
				taken,
			)
			const entry: MemoryIndexEntry = {
				...record.entry,
				name,
				description: record.entry.description ?? oneLine(record.entry.summary),
				type: record.entry.type ?? defaults.type ?? 'project',
				tags: [...record.entry.tags],
			}
			await this.writeMemory(dir, entry, record.content)
			await this.writeIndex(dir, [...entries, entry])
			this.log.info('Memory imported', { 'namzu.memory.id': entry.id })
			return 'imported'
		}, true)
	}
}
