/**
 * The generated `MEMORY.md`: one line per active memory someone chose to
 * keep, the thing a host loads into every prompt so the model knows what
 * exists without reading it.
 *
 * It is an index and never a source. Nothing reads it back; every line is
 * rebuilt from the memory files, so an edit to it is overwritten at the next
 * write and an edit to a memory file reaches it then.
 */

import type { MemoryIndexEntry, MemoryRecord } from '../../types/memory/index.js'
import { memoryOrigin } from './origin.js'

/** Lines of index a prompt carries before the rest is left to search. */
export const MEMORY_INDEX_MAX_LINES = 200
/** One index line, link and description together. */
export const MEMORY_INDEX_LINE_MAX_CHARS = 150

export const MEMORY_INDEX_FILE_HEADER =
	'<!-- Generated from the memory files beside it. Edits here are overwritten; edit a memory file instead. -->'

function clip(text: string, limit: number): string {
	if (text.length <= limit) return text
	if (limit < 1) return ''
	let head = text.slice(0, limit - 1)
	if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1)
	return `${head.trimEnd()}…`
}

/**
 * `- [name](name.md) — description`, never longer than
 * {@link MEMORY_INDEX_LINE_MAX_CHARS}: the description is clipped to the room
 * the link leaves. A name at the 64-character limit leaves ten characters;
 * the link alone always fits.
 */
export function memoryIndexLine(
	entry: Pick<MemoryIndexEntry, 'name' | 'description' | 'summary'>,
): string {
	const name = entry.name ?? ''
	const link = `- [${name}](${name}.md)`
	const description = (entry.description ?? entry.summary).replace(/\s+/g, ' ').trim()
	const room = MEMORY_INDEX_LINE_MAX_CHARS - link.length - 3
	if (!description || room < 2) return link
	return `${link} — ${clip(description, room)}`
}

export interface RenderedMemoryIndex {
	/** The index lines, followed by a note when some were left out. Empty when nothing is listed. */
	readonly text: string
	/**
	 * Memories the index covers: active, named, and not derived by the
	 * runtime (see `memoryOrigin`). Derived records are in the store and found
	 * by search, never counted here.
	 */
	readonly total: number
	/** How many of those `text` does not list. */
	readonly omitted: number
}

/**
 * Where a memory sits in the index. The cap keeps the head, so the head is
 * what nobody else may displace: an operator's `feedback` and `user`
 * memories, then the model's, then everything else.
 */
function tier(record: MemoryRecord): number {
	const personal = record.entry.type === 'feedback' || record.entry.type === 'user'
	if (!personal) return 2
	return memoryOrigin(record.content.metadata) === 'operator' ? 0 : 1
}

/**
 * Render the index of the active, named records a person or the model chose
 * to keep. A record the runtime derived — a run promoter's or
 * consolidation's account of a run — is left out: it is written after almost
 * every run, and an index that changed with it would change the system prompt
 * nearly every turn.
 *
 * Ordered by {@link tier}, then by name, so an unchanged set of memories
 * renders byte-identical text — a prompt that carries it keeps its cache
 * until a memory someone chose to keep changes — and the cap drops `project`
 * and `reference` memories before any operator `feedback` or `user` one.
 */
export function renderMemoryIndex(
	records: readonly MemoryRecord[],
	options: { readonly maxLines?: number } = {},
): RenderedMemoryIndex {
	const maxLines = options.maxLines ?? MEMORY_INDEX_MAX_LINES
	if (!Number.isSafeInteger(maxLines) && maxLines !== Number.POSITIVE_INFINITY) {
		throw new Error('maxLines must be a positive integer')
	}
	if (maxLines < 1) throw new Error('maxLines must be a positive integer')
	const listed = records
		.filter(
			(record) =>
				record.entry.status === 'active' &&
				record.entry.name &&
				memoryOrigin(record.content.metadata) !== 'derived',
		)
		.map((record) => ({ tier: tier(record), name: record.entry.name ?? '', entry: record.entry }))
		.sort((a, b) =>
			a.tier !== b.tier ? a.tier - b.tier : a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
		)
	const shown = listed.slice(0, maxLines).map((row) => memoryIndexLine(row.entry))
	const omitted = listed.length - shown.length
	if (omitted > 0) {
		shown.push(
			`(${omitted} more ${omitted === 1 ? 'memory is' : 'memories are'} not listed here. Use search_memory to find them.)`,
		)
	}
	return { text: shown.join('\n'), total: listed.length, omitted }
}
