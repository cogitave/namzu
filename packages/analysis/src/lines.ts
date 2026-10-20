/**
 * Line arithmetic over UTF-16 offsets.
 *
 * Offsets are positions in the JavaScript string a file decodes to, so a
 * character outside the Basic Multilingual Plane takes two. Lines end at
 * `\n`; a `\r` before it stays on the line it ends, and a lone `\r` or U+2028
 * is not a break. That is the convention an editor's "line N" and the `read`
 * tool share, which is what a citation has to match.
 */

/** Offset of the first character of every line. Always has at least one entry. */
export function lineStarts(text: string): Uint32Array {
	let count = 1
	for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) count++
	const starts = new Uint32Array(count)
	let n = 1
	for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts[n++] = i + 1
	return starts
}

/** One-based line and one-based column of an offset. */
export function position(starts: Uint32Array, offset: number): { line: number; column: number } {
	let lo = 0
	let hi = starts.length - 1
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1
		if ((starts[mid] as number) <= offset) lo = mid
		else hi = mid - 1
	}
	return { line: lo + 1, column: offset - (starts[lo] as number) + 1 }
}

/**
 * The offset a one-based line and column name, or a reason it names none.
 *
 * A column past the end of its line is refused rather than clamped: on a
 * minified file a model that miscounts by a few characters would otherwise be
 * handed the function around the wrong place, with a citation that looks
 * right.
 */
export function offsetOf(
	starts: Uint32Array,
	chars: number,
	line: number,
	column: number,
): { offset: number } | { error: string } {
	if (!Number.isInteger(line) || line < 1 || line > starts.length) {
		return { error: `line ${line} is outside the file, which has ${starts.length} line(s)` }
	}
	const lineStart = starts[line - 1] as number
	const lineEnd = line < starts.length ? (starts[line] as number) - 1 : chars
	const width = lineEnd - lineStart
	if (!Number.isInteger(column) || column < 1 || column - 1 > width) {
		return {
			error: `column ${column} is outside line ${line}, which is ${width} character(s) wide (columns are one-based UTF-16 units)`,
		}
	}
	return { offset: lineStart + column - 1 }
}

/** The bytes the store keeps for a file's line table. */
export function encodeLineStarts(starts: Uint32Array): Uint8Array {
	return new Uint8Array(
		starts.buffer.slice(starts.byteOffset, starts.byteOffset + starts.byteLength),
	)
}

/** The inverse. Copies, because a database blob is not guaranteed to be 4-byte aligned. */
export function decodeLineStarts(blob: Uint8Array): Uint32Array {
	return new Uint32Array(blob.slice().buffer)
}
