import { NamzuError } from '../../types/errors/index.js'
import type { MemoryId } from '../../types/ids/index.js'
import type {
	CreateMemoryParams,
	MemoryIndexEntry,
	UpdateMemoryParams,
} from '../../types/memory/index.js'
import { isMemoryType } from '../../types/memory/index.js'

/** A memory name is a file name and a link target, so it is kept to what is safe as both. */
export const MEMORY_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const MEMORY_NAME_MAX_LENGTH = 64
/**
 * Longest name {@link slugifyMemoryName} derives from a title. Shorter than
 * {@link MEMORY_NAME_MAX_LENGTH} because the name appears twice in an index
 * line (`- [name](name.md) — description`) inside a 150-character budget; a
 * derived name that spends it all leaves the description, the only text a
 * reader judges relevance by, a few words long.
 */
export const DERIVED_MEMORY_NAME_MAX_LENGTH = 32
/** The index file a one-file-per-memory store generates; never a memory's name. */
export const MEMORY_INDEX_NAME = 'MEMORY'

export function isMemoryName(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length <= MEMORY_NAME_MAX_LENGTH &&
		MEMORY_NAME_PATTERN.test(value) &&
		value.toUpperCase() !== MEMORY_INDEX_NAME
	)
}

function invalidField(field: string, reason: string): never {
	throw new NamzuError({
		code: 'invalid_config',
		message: `Memory ${field} ${reason}.`,
		details: { field },
		retryable: false,
	})
}

export function assertMemoryName(value: unknown): asserts value is string {
	if (!isMemoryName(value)) {
		invalidField(
			'name',
			`must be a kebab-case slug of lowercase letters and digits, at most ${MEMORY_NAME_MAX_LENGTH} characters, and not "memory"; got ${JSON.stringify(value)}`,
		)
	}
}

/** Latin letters NFKD leaves whole, because they are letters of their own rather than marked ones. */
const FOLDS: Readonly<Record<string, string>> = {
	ı: 'i',
	ł: 'l',
	đ: 'd',
	ø: 'o',
	ß: 'ss',
	æ: 'ae',
	œ: 'oe',
}

/**
 * The slug a title becomes. Diacritics are folded, everything else outside
 * `a-z0-9` is a separator, and the result is cut at a word boundary. A title
 * with no Latin letters or digits at all becomes `memory-note`, which the
 * caller then suffixes like any other taken name.
 */
export function slugifyMemoryName(text: string): string {
	const slug = text
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.replace(/[ıłđøßæœ]/giu, (letter) => FOLDS[letter.toLowerCase()] ?? letter)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
	let cut = slug
	if (cut.length > DERIVED_MEMORY_NAME_MAX_LENGTH) {
		// Cut at the last word boundary that fits, when the slug has one past
		// its first few characters; a single long word is cut where it is.
		cut = cut.slice(0, DERIVED_MEMORY_NAME_MAX_LENGTH + 1)
		const boundary = cut.lastIndexOf('-')
		cut = boundary > 8 ? cut.slice(0, boundary) : cut.slice(0, DERIVED_MEMORY_NAME_MAX_LENGTH)
		cut = cut.replace(/-+$/, '')
	}
	return isMemoryName(cut) ? cut : 'memory-note'
}

/** `base`, or `base-2`, `base-3`… — the first one nobody holds. */
export function uniqueMemoryName(base: string, taken: ReadonlySet<string>): string {
	if (!taken.has(base)) return base
	for (let n = 2; ; n++) {
		const candidate = `${base}-${n}`
		if (!taken.has(candidate)) return candidate
	}
}

/**
 * A save under a name another memory already holds.
 *
 * Refused rather than suffixed because an explicit name is a claim about
 * WHICH memory this is: two records under one name are the duplicate a
 * caller should have written as an update. The error names the holder so
 * the caller can do exactly that.
 */
export class MemoryNameConflictError extends NamzuError {
	readonly memoryName: string
	readonly existingId: MemoryId

	constructor(name: string, existingId: MemoryId) {
		super({
			code: 'storage_error',
			message: `A memory named "${name}" already exists (${existingId}). Update that memory instead of saving a duplicate, or choose a different name.`,
			details: { name, existingId, reason: 'name_conflict' },
			retryable: false,
		})
		this.name = 'MemoryNameConflictError'
		this.memoryName = name
		this.existingId = existingId
	}
}

/** Why a store refused to write a memory's content. */
export type MemoryContentRejection = 'too_large' | 'nul_byte'

/**
 * A memory the store would write but could not read back.
 *
 * Refused before anything is written: a one-file-per-memory store refuses to
 * load a directory holding a file it cannot read, so writing one would turn
 * a single bad save into every later operation failing.
 */
export class MemoryContentRejectedError extends NamzuError {
	readonly reason: MemoryContentRejection
	/** Encoded size of the file that would have been written, when `too_large`. */
	readonly bytes?: number
	readonly limit?: number

	constructor(
		reason: MemoryContentRejection,
		details: { readonly bytes?: number; readonly limit?: number } = {},
	) {
		super({
			code: 'invalid_config',
			message:
				reason === 'too_large'
					? `The memory would be ${details.bytes} bytes on disk, over the ${details.limit}-byte limit for one memory. Save the rule or fact and where to find the rest, not the rest itself.`
					: 'The memory contains a NUL character, which a memory file cannot hold. Remove it and save again.',
			details: { reason, ...details },
			retryable: false,
		})
		this.name = 'MemoryContentRejectedError'
		this.reason = reason
		if (details.bytes !== undefined) this.bytes = details.bytes
		if (details.limit !== undefined) this.limit = details.limit
	}
}

/** Refuse malformed optional fields before a store writes anything. */
export function assertOptionalMemoryFields(
	params: Pick<CreateMemoryParams, 'name' | 'description' | 'type'>,
): void {
	if (params.name !== undefined) assertMemoryName(params.name)
	if (params.type !== undefined && !isMemoryType(params.type)) {
		invalidField('type', 'must be user, feedback, project or reference')
	}
	if (params.description !== undefined) {
		if (typeof params.description !== 'string') invalidField('description', 'must be a string')
		if (/[\r\n]/.test(params.description)) invalidField('description', 'must be a single line')
	}
}

/** The holder of `name` other than `self`, if any. */
export function nameHolder(
	entries: readonly MemoryIndexEntry[],
	name: string,
	self?: MemoryId,
): MemoryIndexEntry | undefined {
	return entries.find((entry) => entry.name === name && entry.id !== self)
}

/** Copy the optional typed fields onto an entry, leaving absent ones absent. */
export function withOptionalFields(
	entry: MemoryIndexEntry,
	fields: Pick<UpdateMemoryParams, 'name' | 'description' | 'type'>,
): MemoryIndexEntry {
	const name = fields.name ?? entry.name
	const description = fields.description ?? entry.description
	const type = fields.type ?? entry.type
	return {
		...entry,
		...(name !== undefined ? { name } : {}),
		...(description !== undefined ? { description } : {}),
		...(type !== undefined ? { type } : {}),
	}
}
