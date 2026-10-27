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
	/**
	 * `[start, end]`, 1-indexed inclusive.
	 *
	 * Typed as a number array rather than a pair because the tool's schema
	 * pins the length at two with `.length(2)` instead of a `z.tuple` — a
	 * tuple renders as draft-07 `items: [a, b]`, which a 2020-12 wire refuses.
	 * The parse still rejects any other length, so a caller reaching here has
	 * two numbers; `resolveReadWindow` reads them defensively anyway, because
	 * this interface is also implemented by hand elsewhere in the kernel.
	 */
	readonly readRange?: readonly number[]
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
	// One definition of a file's length for the header, the notice and the
	// past-end warning: a final newline ends a line, it does not start another.
	const lineCount = countFileLines(content)
	const { start, end } = resolveReadWindow(input, lineCount)
	// A file with no text in it, or a window that opens after its last line,
	// has nothing to number. Say that in words instead of printing a numbered
	// empty line or a "PARTIAL view" range that runs backwards.
	if (content === '') {
		return {
			output: 'Warning: the file exists but is empty.',
			totalLines: 0,
			returnedLines: 0,
			partial: false,
		}
	}
	if (start >= lineCount) {
		return {
			output: `Warning: the file is shorter than the requested start (line ${start + 1}). It has ${lineCount} ${lineCount === 1 ? 'line' : 'lines'}.`,
			totalLines: lineCount,
			returnedLines: 0,
			// Nothing of the file was shown, so this must never stand in for it.
			partial: true,
		}
	}
	const selected = lines.slice(start, Math.min(end, lineCount))
	const numbered = selected.map((line, i) => `${start + i + 1}\t${line}`).join('\n')
	return {
		output: numbered + partialViewNotice(start, selected.length, lineCount),
		totalLines: lineCount,
		returnedLines: selected.length,
		partial: selected.length < lineCount,
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

/** The number of lines a file has: a final newline ends a line, it does not start another. */
export function countFileLines(content: string): number {
	if (content === '') return 0
	const parts = content.split('\n').length
	return content.endsWith('\n') ? parts - 1 : parts
}

export function resolveReadWindow(
	input: ReadWindowRequest,
	totalLines: number,
): { start: number; end: number } {
	const [first, last] = input.readRange ?? []
	if (first !== undefined && last !== undefined) {
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

/**
 * Largest file `read` returns whole when the caller named no window.
 * A file over it is refused with the way to read part of it.
 */
export const MAX_READ_BYTES = 262_144

/** Largest read result, in estimated tokens. */
export const MAX_READ_TOKENS = 25_000

/**
 * Bytes of text one token is allowed to stand for when bounding a SELECTED
 * window by its bytes: a window may hold at most `tokens * 128` bytes before
 * it is refused outright, without estimating anything.
 */
const SELECTED_BYTES_PER_TOKEN = 128

/**
 * What `allow_large` multiplies both caps by.
 *
 * The caps it lifts are "what still fits in the context left this turn",
 * which this kernel does not track, so it lifts them by a fixed factor.
 */
export const ALLOW_LARGE_FACTOR = 4

/** Share of the page a trimmed first page is aimed at, so the estimate lands under the cap. */
const TRIM_TARGET = 0.85

/** The ways a read can be refused before it returns anything. */
export type ReadRefusal = string

export interface ReadCaps {
	readonly maxBytes: number
	readonly maxTokens: number
}

export interface ReadCapOptions {
	readonly path: string
	/** File extension with the dot, lower case; JSON text is denser per token. */
	readonly ext: string
	readonly allowLarge?: boolean
	/** Overrides for the defaults, from the host's environment. */
	readonly caps?: Partial<ReadCaps>
}

/** Estimated tokens: characters over four, over two for JSON text. */
export function estimateReadTokens(text: string, ext: string): number {
	const perToken = ext === '.json' || ext === '.jsonl' || ext === '.jsonc' ? 2 : 4
	return Math.round(text.length / perToken)
}

export function humanBytes(n: number): string {
	if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`
	if (n >= 1024) return `${Math.round(n / 1024)} KiB`
	return `${n} B`
}

function allowLargeHint(allowedAlready: boolean): string {
	return allowedAlready
		? ' Even with allow_large this is more than a read may return.'
		: ' To read it anyway, call read again with allow_large: true, but only if you need all of it or were asked for the whole file.'
}

/**
 * Render a read, or refuse it, under the size and token caps.
 *
 * Three rules, in the order they are checked:
 *
 * 1. No window named and the file over {@link MAX_READ_BYTES}: refuse. A caller
 *    that asked for a window (`readRange`, `limit`) has chosen its size.
 * 2. A selected window over `maxTokens * 128` bytes: refuse.
 * 3. The selected text over `maxTokens` by estimate: for the first page of an
 *    unwindowed read, return the lines that fit with a notice naming the next
 *    call; for any other read, refuse and report the count.
 *
 * Pure, like {@link renderNumberedRead}; a read that none of this touches
 * renders byte for byte as `renderNumberedRead` does.
 */
export function renderCappedRead(
	content: string,
	byteLength: number,
	input: ReadWindowRequest,
	options: ReadCapOptions,
): { ok: true; rendered: RenderedRead } | { ok: false; message: ReadRefusal } {
	const factor = options.allowLarge ? ALLOW_LARGE_FACTOR : 1
	const maxBytes = (options.caps?.maxBytes ?? MAX_READ_BYTES) * factor
	const maxTokens = (options.caps?.maxTokens ?? MAX_READ_TOKENS) * factor
	const hint = allowLargeHint(options.allowLarge === true)

	const windowed = input.readRange !== undefined || input.limit !== undefined
	if (!windowed && byteLength > maxBytes) {
		return {
			ok: false,
			message: `File content (${humanBytes(byteLength)}) exceeds the maximum allowed size (${humanBytes(maxBytes)}). Use offset and limit to read part of it, or search for what you need instead of reading all of it.${hint}`,
		}
	}

	const lines = content.split('\n')
	const lineCount = countFileLines(content)
	const { start, end } = resolveReadWindow(input, lineCount)
	const selected = lines.slice(start, Math.min(end, lineCount))
	const selectedText = selected.join('\n')

	const selectedBytes = Buffer.byteLength(selectedText, 'utf8')
	if (selectedBytes > maxTokens * SELECTED_BYTES_PER_TOKEN) {
		return {
			ok: false,
			message: `The requested lines hold over ${humanBytes(maxTokens * SELECTED_BYTES_PER_TOKEN)} of text, more than a read can return. Use a smaller limit; if a single line is this large, no limit will fit it, so search for what you need instead.${hint}`,
		}
	}

	const tokens = estimateReadTokens(selectedText, options.ext)
	if (tokens <= maxTokens) {
		return { ok: true, rendered: renderNumberedRead(content, input) }
	}

	const firstPage = input.readRange === undefined && input.limit === undefined && start === 0
	if (!firstPage) {
		return {
			ok: false,
			message: `File content (${tokens} tokens) exceeds the maximum allowed tokens (${maxTokens}). Use offset and limit to read part of it, or search for what you need instead of reading all of it.${hint}`,
		}
	}
	return {
		ok: true,
		rendered: trimFirstPage(selected, lineCount, selectedText, tokens, maxTokens, options.path),
	}
}

/**
 * The first page of a file whose first window is over the token cap: the
 * leading lines that fit, numbered, and a notice that says it is a page and
 * names the next call.
 *
 * Sized from the measured ratio of characters to tokens, aimed at
 * {@link TRIM_TARGET} of the cap, and shrunk by 30% up to six times if the
 * estimate still lands over. A page whose first lines are themselves too long
 * falls back to a character excerpt, which cannot be paged by line.
 */
function trimFirstPage(
	selected: readonly string[],
	totalLines: number,
	selectedText: string,
	tokens: number,
	maxTokens: number,
	path: string,
): RenderedRead {
	const charsPerToken = Math.max(0.5, selectedText.length / Math.max(1, tokens))
	const fits = (text: string) => text.length / charsPerToken <= maxTokens

	let keep = Math.max(
		1,
		Math.min(
			selected.length,
			Math.floor(((selected.length * maxTokens) / Math.max(1, tokens)) * TRIM_TARGET),
		),
	)
	let page = selected.slice(0, keep).join('\n')
	for (let i = 0; i < 6; i++) {
		if (fits(page) || keep <= 1) break
		keep = Math.max(1, Math.floor(keep * 0.7))
		page = selected.slice(0, keep).join('\n')
	}

	const tail = 'Do NOT answer from this page alone if the answer may be further in the file.]'
	if (!fits(page) || page.trim() === '') {
		let chars = Math.max(1, Math.floor(maxTokens * charsPerToken * TRIM_TARGET))
		let excerpt = selectedText.slice(0, chars)
		for (let i = 0; i < 6 && !fits(excerpt); i++) {
			chars = Math.max(1, Math.floor(chars * 0.7))
			excerpt = selectedText.slice(0, chars)
		}
		const last = excerpt.charCodeAt(excerpt.length - 1)
		if (last >= 0xd800 && last <= 0xdbff) excerpt = excerpt.slice(0, -1)
		const shown = excerpt.split('\n').length
		return {
			output: `${numbered(excerpt.split('\n'))}\n\n[Truncated: PARTIAL view — ${path}: showing the first ${excerpt.length} of ${selectedText.length} characters (${tokens} tokens, cap ${maxTokens}); this file has very long lines and cannot be paged by line. Use grep to find a specific section, or read with offset and limit. ${tail}`,
			totalLines,
			returnedLines: shown,
			partial: true,
		}
	}

	return {
		output: `${numbered(selected.slice(0, keep))}\n\n[Truncated: PARTIAL view — ${path}: showing lines 1-${keep} of ${totalLines} total (${tokens} tokens, cap ${maxTokens}). Call read with offset=${keep} limit=${keep} for the next page, or grep to find a specific section. ${tail}`,
		totalLines,
		returnedLines: keep,
		partial: true,
	}
}

function numbered(lines: readonly string[]): string {
	return lines.map((line, i) => `${i + 1}\t${line}`).join('\n')
}
