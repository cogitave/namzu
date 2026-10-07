// Block boundaries for streamed Markdown, so a settled block keeps its parsed tree while only the
// tail is parsed again. The pattern (split at blank lines outside a fence, keep the tail live) is
// the one in T3 Code's ChatMarkdown and OpenCode's markdown-stream (both MIT); this is a fresh
// implementation that favours merging over splitting: a wrong merge only costs a re-parse, a
// wrong split changes what is shown.

const BLANK = /^[ \t]*\r?\n?$/
const FENCE = /^[ \t]*(`{3,}|~{3,})(.*?)\r?\n?$/
const LIST_MARKER = /^(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/
// A definition, footnote definition or HTML block each changes how text before or after it reads
// (an HTML block even swallows the fence-like lines inside it), so a text holding one is never split.
const WHOLE_TEXT_ONLY = [
	/^[ \t>]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?\[[^\]\n]+\]:/m,
	/^[ \t>]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?<(?:[A-Za-z][A-Za-z0-9-]*(?=[\s/>]|$)|\/[A-Za-z]|!|\?)/m,
]

function lineEnds(text: string): number[] {
	const ends: number[] = []
	for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) ends.push(at + 1)
	if (!ends.length || ends[ends.length - 1] !== text.length) ends.push(text.length)
	return ends
}

/**
 * Cut `text` into consecutive pieces whose concatenation is `text` exactly. A cut falls only after
 * the blank lines that end a block, never inside a fenced code block, never before an indented line
 * (list or code continuation), and never between two items of one list.
 */
export function splitMarkdownBlocks(text: string): string[] {
	return scan(text).pieces
}

/**
 * What to hand the parser for each piece: the piece without the line break and empty lines that
 * end it, so the tail does not parse again when its closing blank line arrives. A piece that ends
 * inside an open fence or indented code keeps them, because there they are code.
 */
export function markdownBlockSources(text: string): string[] {
	const { pieces, keepEnd } = scan(text)
	return pieces.map((piece, index) =>
		keepEnd && index === pieces.length - 1 ? piece : piece.replace(/(?:\r?\n)+$/, ''),
	)
}

/** `keepEnd`: the last piece's ending is content (an open fence, indented code) or the text was left whole. */
function scan(text: string): { pieces: string[]; keepEnd: boolean } {
	const whole = (): { pieces: string[]; keepEnd: boolean } => ({
		pieces: text ? [text] : [],
		// Left exactly as it came: this is the unsplit render.
		keepEnd: true,
	})
	if (!text) return { pieces: [], keepEnd: false }
	// A bare CR is a line ending to Markdown but not to this scanner.
	if (/\r(?!\n)/.test(text) || WHOLE_TEXT_ONLY.some((pattern) => pattern.test(text))) return whole()
	const blocks: string[] = []
	let start = 0
	let blockHasList = false
	let blockHasContent = false
	let blockHasIndentedCode = false
	let fence: { marker: string; length: number; indent: number } | undefined
	let previousBlank = false
	let lineStart = 0
	for (const end of lineEnds(text)) {
		const line = text.slice(lineStart, end)
		const blank = BLANK.test(line)
		const insideFence = fence !== undefined
		const opening = insideFence ? undefined : FENCE.exec(line)
		if (!blank && previousBlank && !fence && blockHasContent) {
			const first = line.charAt(0)
			const indented = first === ' ' || first === '\t'
			const nextIsListItem = LIST_MARKER.test(line)
			// Everything before this line ends with the blank lines that closed its block.
			// micromark reads what follows indented code differently from a fresh parse (a list start
			// becomes text), so a block with indented code is never cut after.
			if (!indented && !blockHasIndentedCode && !(nextIsListItem && blockHasList)) {
				blocks.push(text.slice(start, lineStart))
				start = lineStart
				blockHasList = false
				blockHasContent = false
				blockHasIndentedCode = false
			}
		}
		if (!blank) {
			blockHasContent = true
			// What a fence holds is code: it says nothing about lists or indented code around it.
			if (!insideFence && !blockHasList && /^(?: {4}|\t)/.test(line)) blockHasIndentedCode = true
			// Four spaces make a line code, not a fence, unless a list item supplies the indent.
			const deep = !blockHasList && /^(?: {4}|\t)/.test(line)
			const indent = line.length - line.trimStart().length
			if (fence) {
				// A list item's fence ends where the item does, so a shallower line leaves us unsure.
				if (blockHasList && indent < fence.indent) return whole()
				const close = new RegExp(
					`^[ \\t]*${fence.marker === '`' ? '`' : '~'}{${fence.length},}[ \\t]*\\r?\\n?$`,
				)
				if (!deep && close.test(line)) fence = undefined
			} else if (opening) {
				// A fence-like line we cannot classify with certainty: leave the text whole.
				if (deep) return whole()
				const marker = opening[1] ?? '```'
				// An info string on a backtick fence cannot hold a backtick; then it is not a fence.
				if (marker[0] !== '`' || !(opening[2] ?? '').includes('`'))
					fence = { marker: marker[0] ?? '`', length: marker.length, indent }
			}
			if (!insideFence && LIST_MARKER.test(line.trimStart())) blockHasList = true
		}
		previousBlank = blank
		lineStart = end
	}
	blocks.push(text.slice(start))
	return { pieces: blocks, keepEnd: fence !== undefined || blockHasIndentedCode }
}
