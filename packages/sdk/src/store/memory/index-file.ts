/**
 * The generated `MEMORY.md`: one line per active memory, the thing a host
 * loads into every prompt so the model knows what exists without reading it.
 *
 * It is an index and never a source. Nothing reads it back; every line is
 * rebuilt from the memory files, so an edit to it is overwritten at the next
 * write and an edit to a memory file reaches it then.
 */

import type { MemoryIndexEntry } from '../../types/memory/index.js'

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

/** `- [name](name.md) — description`, the description clipped so the line fits. */
export function memoryIndexLine(
	entry: Pick<MemoryIndexEntry, 'name' | 'description' | 'summary'>,
): string {
	const name = entry.name ?? ''
	const link = `- [${name}](${name}.md)`
	const description = (entry.description ?? entry.summary).replace(/\s+/g, ' ').trim()
	if (!description) return link
	const room = MEMORY_INDEX_LINE_MAX_CHARS - link.length - 3
	return `${link} — ${clip(description, Math.max(room, 16))}`
}

export interface RenderedMemoryIndex {
	/** The index lines, followed by a note when some were left out. Empty when nothing is listed. */
	readonly text: string
	/** Active named memories in the store. */
	readonly total: number
	/** How many of those `text` does not list. */
	readonly omitted: number
}

/**
 * Render the index of the active, named entries, sorted by name so an
 * unchanged store renders byte-identical text — a prompt that carries it
 * keeps its cache until a memory actually changes.
 */
export function renderMemoryIndex(
	entries: readonly MemoryIndexEntry[],
	options: { readonly maxLines?: number } = {},
): RenderedMemoryIndex {
	const maxLines = options.maxLines ?? MEMORY_INDEX_MAX_LINES
	if (!Number.isSafeInteger(maxLines) && maxLines !== Number.POSITIVE_INFINITY) {
		throw new Error('maxLines must be a positive integer')
	}
	if (maxLines < 1) throw new Error('maxLines must be a positive integer')
	const listed = entries
		.filter((entry) => entry.status === 'active' && entry.name)
		.sort((a, b) =>
			(a.name ?? '') < (b.name ?? '') ? -1 : (a.name ?? '') > (b.name ?? '') ? 1 : 0,
		)
	const shown = listed.slice(0, maxLines).map(memoryIndexLine)
	const omitted = listed.length - shown.length
	if (omitted > 0) {
		shown.push(
			`(${omitted} more ${omitted === 1 ? 'memory is' : 'memories are'} not listed here. Use search_memory to find them.)`,
		)
	}
	return { text: shown.join('\n'), total: listed.length, omitted }
}
