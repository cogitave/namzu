import type { ToolTextWindow } from '../types/tool/presentation.js'
import { copyString } from '../utils/copy-string.js'

/** Lines kept from the start and from the end of a long text. */
export const WINDOW_HEAD_LINES = 80
export const WINDOW_TAIL_LINES = 40
/** A window never holds more than this many characters in either half. */
export const WINDOW_HALF_CHARS = 6_000

function clipHead(text: string, max: number): string {
	if (text.length <= max) return text
	// By code point so a surrogate pair is never cut in two.
	let end = max
	const last = text.charCodeAt(end - 1)
	if (last >= 0xd800 && last <= 0xdbff) end -= 1
	return `${text.slice(0, end)}…`
}

function clipTail(text: string, max: number): string {
	if (text.length <= max) return text
	let start = text.length - max
	const first = text.charCodeAt(start)
	if (first >= 0xdc00 && first <= 0xdfff) start += 1
	return `…${text.slice(start)}`
}

/**
 * A bounded window onto `text` for the person's view: everything when it is
 * short, otherwise the first and last lines with a count of what lay between.
 * The model's own text is not touched; this is built beside it.
 */
export function windowText(
	text: string,
	totalBytes = Buffer.byteLength(text, 'utf8'),
): ToolTextWindow {
	const body = text.endsWith('\n') ? text.slice(0, -1) : text
	const lines = body.length === 0 ? [] : body.split('\n')
	const totalLines = lines.length
	if (totalLines <= WINDOW_HEAD_LINES + WINDOW_TAIL_LINES && body.length <= WINDOW_HALF_CHARS * 2) {
		return { head: copyString(body), totalLines, totalBytes }
	}
	const headLines = lines.slice(0, WINDOW_HEAD_LINES)
	const tailLines =
		totalLines > WINDOW_HEAD_LINES
			? lines.slice(Math.max(WINDOW_HEAD_LINES, totalLines - WINDOW_TAIL_LINES))
			: []
	const head = clipHead(headLines.join('\n'), WINDOW_HALF_CHARS)
	const tail = clipTail(tailLines.join('\n'), WINDOW_HALF_CHARS)
	const omittedLines = totalLines - headLines.length - tailLines.length
	return {
		head: copyString(head),
		...(tail ? { tail: copyString(tail) } : {}),
		...(omittedLines > 0 ? { omittedLines } : {}),
		totalLines,
		totalBytes,
	}
}

const SAMPLE_CHARS = 8_000

/**
 * Whether decoded output is a stream of bytes and not text: a NUL, or a
 * noticeable share of control characters and replacement characters that no
 * terminal prints. ANSI escapes, tabs, backspaces and line ends are text.
 */
export function looksBinary(text: string): boolean {
	const sample = text.length > SAMPLE_CHARS ? text.slice(0, SAMPLE_CHARS) : text
	if (sample.length === 0) return false
	let odd = 0
	for (let i = 0; i < sample.length; i++) {
		const code = sample.charCodeAt(i)
		if (code === 0) return true
		if (code === 0xfffd) odd++
		else if (
			code < 0x20 &&
			code !== 9 &&
			code !== 10 &&
			code !== 13 &&
			code !== 27 &&
			code !== 8 &&
			code !== 7 &&
			code !== 12
		)
			odd++
		else if (code === 0x7f) odd++
	}
	return odd / sample.length > 0.02
}
