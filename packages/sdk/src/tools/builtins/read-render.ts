/**
 * How `read` turns a file's body into the text the model sees.
 *
 * Pulled out of the tool for the reason `edit-apply` was: a second caller —
 * the resume seed, deciding whether a `read` receipt in history shows exactly
 * the body it already believes the file had — has to produce byte-for-byte
 * what the tool produced, and a parallel implementation of the numbering or
 * the window arithmetic would silently stop agreeing with it.
 *
 * Pure by construction: no filesystem access, no `ToolContext`.
 */

/**
 * Lines returned when the caller specifies no window.
 *
 * Chosen to cover the overwhelming majority of source files whole while
 * bounding the pathological case.
 */
export const DEFAULT_READ_LINES = 2000

/** The window fields of `read`'s input; the path plays no part in rendering. */
export interface ReadWindowRequest {
	readonly readRange?: readonly [number, number]
	readonly offset?: number
	readonly limit?: number
}

export interface RenderedRead {
	/** Exactly what `read` returns as its output for this body and window. */
	readonly output: string
	readonly totalLines: number
	readonly returnedLines: number
	/** Whether the window left any of the file out, which is what adds the notice. */
	readonly partial: boolean
}

/**
 * Render `content` the way `read` renders it.
 *
 * The numbering is what makes this reversible enough to compare against: every
 * line goes out behind its own `${n}\t`, so two different bodies cannot render
 * to one string, and the partial-view notice below — whose lines carry no such
 * prefix — cannot be mistaken for part of a body.
 */
export function renderNumberedRead(content: string, input: ReadWindowRequest): RenderedRead {
	const lines = content.split('\n')
	const { start, end } = resolveReadWindow(input, lines.length)
	const selected = lines.slice(start, end)
	const numbered = selected.map((line, i) => `${start + i + 1}\t${line}`).join('\n')
	return {
		output: numbered + partialViewNotice(start, selected.length, lines.length),
		totalLines: lines.length,
		returnedLines: selected.length,
		partial: selected.length < lines.length,
	}
}

/**
 * Tell the model, explicitly, when it is looking at a window rather than
 * the file.
 *
 * Without this a truncated read is indistinguishable from a short file, and
 * the agent reasons about a fragment as if it were the whole thing — the
 * most expensive silent failure a read tool can have. The notice names the
 * exact next call rather than describing it.
 */
function partialViewNotice(start: number, returned: number, total: number): string {
	if (returned >= total) return ''
	const shownTo = start + returned
	return [
		'',
		'',
		`[PARTIAL view — lines ${start + 1}-${shownTo} of ${total}.`,
		`Continue with read({ offset: ${shownTo}, limit: N }), or narrow with grep.]`,
	].join('\n')
}

export function resolveReadWindow(
	input: ReadWindowRequest,
	totalLines: number,
): { start: number; end: number } {
	if (input.readRange) {
		const [first, last] = input.readRange
		const start = Math.max(0, first - 1)
		const end = Math.min(totalLines, Math.max(start, last))
		return { start, end }
	}
	const start = Math.max(0, input.offset ?? 0)
	// A bare `read({ path })` used to return the entire file, so a 2 MB
	// lockfile became ~500k tokens in one tool_result. Default to a window
	// and say so in the output; the model asks for more when it needs it.
	const end = input.limit ? start + input.limit : Math.min(totalLines, start + DEFAULT_READ_LINES)
	return { start, end }
}
