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

/**
 * What kind of thing a memory records, which decides when it is worth
 * reading again:
 *
 * - `user` — who the operator is: role, expertise, preferences.
 * - `feedback` — a rule the operator gave about how to work, with why.
 * - `project` — a fact or decision about the work that the code and its
 *   history do not already say.
 * - `reference` — where to look: a dashboard, a ticket queue, a document.
 */
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

export const MEMORY_TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference']

export function assertMemoryType(type: MemoryType): void {
	switch (type) {
		case 'user':
		case 'feedback':
		case 'project':
		case 'reference':
			return
		default: {
			const _exhaustive: never = type
			throw new Error(`Unknown MemoryType: ${_exhaustive}`)
		}
	}
}

export function isMemoryType(value: unknown): value is MemoryType {
	return typeof value === 'string' && (MEMORY_TYPES as readonly string[]).includes(value)
}

export interface MemoryIndexEntry {
	readonly id: MemoryId
	readonly title: string
	readonly summary: string
	readonly tags: readonly string[]
	readonly status: MemoryStatus
	readonly createdAt: number
	readonly updatedAt: number
	/**
	 * Unique kebab-case slug (`[a-z0-9]+(-[a-z0-9]+)*`, at most 64
	 * characters). A store that keeps one file per memory names the file
	 * after it, and `[[name]]` in another memory's body links here. Absent on
	 * records written before names existed.
	 */
	readonly name?: string
	/** One line saying what the memory is for, used to judge relevance without reading it. */
	readonly description?: string
	/** Absent on records written before types existed. */
	readonly type?: MemoryType
}

export interface MemoryContent {
	readonly id: MemoryId
	readonly content: string
	readonly format: 'text' | 'markdown' | 'json'
	readonly metadata?: Record<string, unknown>
}

/** Metadata and body observed together at one store read boundary. */
export interface MemoryRecord {
	readonly entry: MemoryIndexEntry
	readonly content: MemoryContent
}

/** A full record and an opaque token for that exact logical snapshot. */
export interface VersionedMemoryRecord extends MemoryRecord {
	readonly revision: string
}

export interface MemorySearchParams {
	readonly query?: string
	readonly tags?: string[]
	readonly status?: MemoryStatus
	readonly limit?: number
	/** Match at least one exact normalized word token before limiting results. Empty means no constraint. */
	readonly requiredIdentifiers?: readonly string[]
	/** Maximum indexed candidates to examine in one page; omitted scans all. */
	readonly maxScanned?: number
	/** Skip this many candidates in newest-first scan order; a new search starts at zero. */
	readonly scanOffset?: number
}

export interface MemorySearchResult {
	readonly entries: readonly MemoryIndexEntry[]
	/** Exact unless truncated is true; then counts matches in the scanned candidates only. */
	readonly totalCount: number
	/** True when the search stopped before examining all eligible candidates. */
	readonly truncated?: boolean
	/** Number of eligible candidates examined in this page. */
	readonly scannedCount?: number
	/** Pass as scanOffset to inspect the next page; absent when this scan reached the end. */
	readonly nextScanOffset?: number
}

export interface CreateMemoryParams {
	readonly title: string
	readonly summary: string
	readonly content: string
	readonly tags?: string[]
	readonly format?: 'text' | 'markdown' | 'json'
	readonly metadata?: Record<string, unknown>
	/**
	 * Unique slug for this memory. A store refuses a name another record
	 * already holds with {@link MemoryNameConflictError}, which names that
	 * record, so a caller updates it instead of writing a second copy. When
	 * omitted, a store that requires names derives one from `title` and
	 * suffixes it (`-2`, `-3`) until it is free.
	 */
	readonly name?: string
	readonly description?: string
	readonly type?: MemoryType
}

/** Change a memory's content or explicitly archive/reactivate it. */
export interface UpdateMemoryParams extends Partial<CreateMemoryParams> {
	readonly status?: MemoryStatus
}

export interface MemoryStore {
	create(params: CreateMemoryParams): Promise<{ entry: MemoryIndexEntry; content: MemoryContent }>
	get(id: MemoryId): Promise<MemoryContent | undefined>
	/** Current metadata/body snapshot; supports rechecking status after search. */
	getRecord?(id: MemoryId): Promise<MemoryRecord | undefined>
	update(id: MemoryId, updates: UpdateMemoryParams): Promise<MemoryIndexEntry | undefined>
	delete(id: MemoryId): Promise<boolean>
	list(params?: MemorySearchParams): Promise<MemorySearchResult>
}

/**
 * Opt-in compare-and-set operations. A supplied revision is checked together
 * with the mutation, under the store's own coordination boundary. Implementing
 * only one of these methods is not enough to advertise conditional writes.
 */
export interface ConditionalMemoryStore extends MemoryStore {
	/** The record and a token covering its complete logical snapshot. */
	getVersionedRecord(id: MemoryId): Promise<VersionedMemoryRecord | undefined>
	/** Throw MemoryRevisionConflictError if the record changed or disappeared. */
	updateIfRevision(
		id: MemoryId,
		updates: UpdateMemoryParams,
		expectedRevision: string,
	): Promise<MemoryIndexEntry>
	/** Throw MemoryRevisionConflictError if the record changed or disappeared. */
	deleteIfRevision(id: MemoryId, expectedRevision: string): Promise<void>
}

export function hasConditionalMemoryWrites(store: MemoryStore): store is ConditionalMemoryStore {
	const candidate = store as Partial<ConditionalMemoryStore>
	return (
		typeof candidate.getVersionedRecord === 'function' &&
		typeof candidate.updateIfRevision === 'function' &&
		typeof candidate.deleteIfRevision === 'function'
	)
}

export interface MemoryIndex {
	search(params: MemorySearchParams): MemorySearchResult
	getEntry(id: MemoryId): MemoryIndexEntry | undefined
	allEntries(): readonly MemoryIndexEntry[]
	count(): number
	rebuild(entries: MemoryIndexEntry[]): void
}
