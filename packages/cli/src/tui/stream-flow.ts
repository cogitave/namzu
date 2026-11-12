/**
 * How a reply is drawn while it is being written.
 *
 * ## Two halves
 *
 * **What is drawn of the tail.** {@link tailView} takes the text of the reply
 * that is not printed yet and returns what may be drawn of it now: the text as
 * far as it is decided, and nothing past that. Nothing that could still become
 * something else is drawn as what it is not (see the rule per construct on
 * `tailView`), so no raw marker is shown and then replaced.
 *
 * **What is printed.** {@link freezeMore} finds the part of the tail that is
 * final, and cuts it off into a {@link PrintedChunk}. A chunk is rendered by
 * the same Markdown the whole reply used to be rendered by, told only how it
 * joins the one before it, so the rows of all the chunks together are the rows
 * the whole reply has. `stream-flow.test.tsx` renders a corpus both ways and
 * holds the two equal at every position.
 *
 * Pure, so every rule here is a test rather than a hope.
 */

import { inlineDisplaySpans, wrapSpans } from './markdown-wrap.js'
import { LINE_SHAPES, openMarkersIn, scanBlockRanges } from './markdownParser.js'
import type { BlockRange } from './markdownParser.js'
import { terminalDisplayText } from './terminal-display.js'
import type { MdBlockType, PrintedChunk, TranscriptMessage } from './types.js'

/** The tail is redrawn at most this often: about twelve times a second. */
export const PACE_MS = 80

export type PaceDecision =
	| { readonly action: 'flush' }
	| { readonly action: 'arm'; readonly delay: number }
	| { readonly action: 'wait' }

/**
 * What to do with text that has just arrived.
 *
 * Flush at once when the last redraw was long enough ago, so the first words of
 * a reply appear with no wait; otherwise arm the one timer that carries
 * everything arriving before it to the next redraw. The timer exists only while
 * something is waiting: with nothing arriving there is nothing to fire.
 */
export function paceDecision(
	now: number,
	lastFlushAt: number | undefined,
	timerArmed: boolean,
): PaceDecision {
	const wait = lastFlushAt === undefined ? 0 : PACE_MS - (now - lastFlushAt)
	if (wait <= 0) return { action: 'flush' }
	return timerArmed ? { action: 'wait' } : { action: 'arm', delay: wait }
}

export interface FlowContext {
	/** Freeze and print finished parts. Off in fullscreen and raw mode. */
	readonly freeze: boolean
	/** Cells the reply's text has (the transcript's content width). */
	readonly width: number
	/** Terminal height, to bound the live part. */
	readonly rows: number
	readonly hyperlinks: boolean
}

/**
 * The height a reply's live part reckons with: the terminal's, less the rows the live region
 * holds besides it (the plan under the working line, the running calls, a queued message).
 * Without that the part kept live plus these rows could be as tall as the terminal.
 */
export function flowRows(terminalRows: number, otherRows: number): number {
	return Math.max(1, terminalRows - Math.max(0, otherRows))
}

/** Where the tail begins: how it joins what was printed before it. */
export interface TailState {
	readonly join: 'block' | 'text' | 'code'
	readonly lang?: string
	/** The block before the tail's first block, for the blank row between them. */
	readonly lead: MdBlockType | null
}

export function tailStateOf(printed: readonly PrintedChunk[] | undefined): TailState {
	const last = printed?.[printed.length - 1]
	if (!last) return { join: 'block', lead: null }
	return {
		join: last.open === 'none' ? 'block' : last.open,
		...(last.lang !== undefined ? { lang: last.lang } : {}),
		lead: last.last,
	}
}

export function printedLength(printed: readonly PrintedChunk[] | undefined): number {
	let n = 0
	for (const chunk of printed ?? []) n += chunk.text.length
	return n
}

/** A reply that is only prose and code: the one kind that is cut into printed parts. */
export function isPlainReply(m: TranscriptMessage): boolean {
	return (
		m.role === 'assistant' &&
		m.kind === undefined &&
		m.glyph === undefined &&
		m.meta === undefined &&
		m.detail === undefined &&
		m.shell === undefined &&
		m.checklist === undefined &&
		m.attachments === undefined &&
		m.group === undefined &&
		m.diff === undefined &&
		m.statusRows === undefined &&
		m.contextView === undefined
	)
}

const TYPE_OF: Record<BlockRange['kind'], MdBlockType> = {
	text: 'paragraph',
	heading: 'heading',
	bullet: 'bullet',
	quote: 'quote',
	rule: 'rule',
	code: 'code',
	table: 'table',
}

/** The tail's blocks, in the tail's own offsets, whatever it begins in the middle of. */
function scanTail(tail: string, state: TailState): BlockRange[] {
	if (state.join === 'code') {
		const prefix = '```\n'
		return scanBlockRanges(prefix + tail).map((r) => ({
			...r,
			start: Math.max(0, r.start - prefix.length),
			end: r.end - prefix.length,
		}))
	}
	return scanBlockRanges(tail, state.join === 'text' ? 'text' : undefined)
}

/** Whether a block can no longer change, whatever arrives after it. */
function isFinal(tail: string, r: BlockRange, next: BlockRange | undefined): boolean {
	// The line the block ends on must itself have ended: its last word, or the
	// marker at its end, may still be growing.
	const ended = tail[r.end] === '\n'
	switch (r.kind) {
		case 'heading':
		case 'bullet':
		case 'rule':
			return ended
		case 'code':
			// A closing fence counts once its line has ended: until then it may
			// still become ``` followed by more, which is a code line.
			return r.closed === true && ended
		default: {
			if (!ended) return false
			const nl = tail.indexOf('\n', r.end + 1)
			if (nl >= 0 && tail.slice(r.end + 1, nl).trim() === '') return true
			// The next block begins on the very next line, and that line has ended.
			return next !== undefined && next.start === r.end + 1 && tail.indexOf('\n', next.start) >= 0
		}
	}
}

function fenceLang(tail: string, r: BlockRange): string | undefined {
	const first = tail.slice(r.start, r.end).split('\n')[0] ?? ''
	const lang = LINE_SHAPES.fence.exec(first)?.[1]
	return lang ? lang : undefined
}

/** Wrapped rows of prose, drawn the way the transcript draws a paragraph. */
function paragraphRows(raw: string, width: number, hyperlinks: boolean) {
	const text = terminalDisplayText(
		raw
			.split('\n')
			.map((l) => l.trim())
			.join(' '),
	)
	return wrapSpans(inlineDisplaySpans(text, hyperlinks), width)
}

/** The live part of a long paragraph keeps this many rows. */
const KEEP_ROWS = 3
/** The live part of a long code block keeps this many lines. */
const KEEP_LINES = 3

/** A paragraph's earlier rows, as the offset in `para` where the live part begins, or -1. */
function paragraphCut(para: string, ended: boolean, ctx: FlowContext, cap: number): number {
	const limit = ended ? para.length : para.search(/\s\S*$/u) + 1
	if (limit <= 0) return -1
	const whole = para.slice(0, limit)
	const wholeRows = paragraphRows(whole, ctx.width, ctx.hyperlinks)
	const total = wholeRows.length
	if (total <= cap) return -1
	// Word boundaries: just after a run of whitespace.
	const bounds: number[] = []
	for (const m of whole.matchAll(/\s+/gu)) bounds.push(m.index + m[0].length)
	const keep = total - KEEP_ROWS
	// The largest boundary whose prefix has no more than `keep` rows.
	let lo = 0
	let hi = bounds.length - 1
	let best = -1
	while (lo <= hi) {
		const mid = (lo + hi) >> 1
		if (paragraphRows(para.slice(0, bounds[mid] ?? 0), ctx.width, ctx.hyperlinks).length <= keep) {
			best = mid
			lo = mid + 1
		} else hi = mid - 1
	}
	// Walk back to a boundary whose rows are exactly the first rows of the whole
	// and after which no marker is left open.
	for (let tries = 0; best >= 0 && tries < 40; best--, tries++) {
		const c = bounds[best] ?? 0
		const prefix = para.slice(0, c)
		const rows = paragraphRows(prefix, ctx.width, ctx.hyperlinks)
		if (rows.length >= total) continue
		if (JSON.stringify(rows) !== JSON.stringify(wholeRows.slice(0, rows.length))) continue
		if (openMarkersIn(terminalDisplayText(prefix.replace(/\s*\n\s*/gu, ' '))).length > 0) continue
		return c
	}
	return -1
}

/**
 * Cut the final parts off the tail, as many chunks as there are.
 *
 * Returns the new list of chunks, or `undefined` when nothing froze.
 */
export function freezeMore(
	content: string,
	printed: readonly PrintedChunk[],
	ctx: FlowContext,
): readonly PrintedChunk[] | undefined {
	let chunks = printed
	// The live part leaves room for the activity row and the composer under it.
	const cap = Math.min(14, Math.max(6, ctx.rows - 14))
	for (let guard = 0; guard < 16; guard++) {
		const base = printedLength(chunks)
		const tail = content.slice(base)
		const state = tailStateOf(chunks)
		const ranges = scanTail(tail, state)
		let final = -1
		for (let i = 0; i < ranges.length; i++) {
			if (isFinal(tail, ranges[i] as BlockRange, ranges[i + 1])) final = i
		}
		if (final >= 0) {
			const r = ranges[final] as BlockRange
			const cut = r.end + 1
			const open = 'none' as const
			const lang = state.join === 'code' ? state.lang : undefined
			chunks = [
				...chunks,
				{
					text: tail.slice(0, cut),
					join: state.join,
					...(lang !== undefined ? { lang } : {}),
					last: TYPE_OF[r.kind],
					open,
				},
			]
			continue
		}
		const last = ranges[ranges.length - 1]
		if (!last || ranges.length !== 1) break
		const ended = tail[last.end] === '\n'
		if (last.kind === 'code') {
			const lines = tail.slice(last.start, last.end).split('\n')
			const terminated = ended ? lines.length : lines.length - 1
			const body = terminated - (state.join === 'block' ? 1 : 0)
			if (body <= cap) break
			const freezeLines = terminated - KEEP_LINES
			let cut = last.start
			for (let n = 0; n < freezeLines; n++) cut += (lines[n] ?? '').length + 1
			const lang = state.join === 'code' ? state.lang : fenceLang(tail, last)
			chunks = [
				...chunks,
				{
					text: tail.slice(0, cut),
					join: state.join,
					...(lang !== undefined ? { lang } : {}),
					last: 'code',
					open: 'code',
				},
			]
			break
		}
		if (last.kind === 'text' && tail.slice(0, last.start).trim() === '') {
			const c = paragraphCut(tail.slice(last.start, last.end), ended, ctx, cap)
			if (c > 0) {
				chunks = [
					...chunks,
					{
						text: tail.slice(0, last.start + c),
						join: state.join,
						...(state.join === 'code' && state.lang !== undefined ? { lang: state.lang } : {}),
						last: 'paragraph',
						open: 'text',
					},
				]
			}
		}
		break
	}
	return chunks === printed ? undefined : chunks
}

/** `m` with `delta` appended, and whatever has become final printed. */
export function appendReply(
	m: TranscriptMessage,
	delta: string,
	ctx: FlowContext | undefined,
): TranscriptMessage {
	const content = m.content + delta
	if (!ctx?.freeze || !m.pending || !isPlainReply(m)) return { ...m, content }
	const printed = m.printed ?? []
	if (!content.startsWith(chunksText(printed))) return { ...m, content }
	const next = freezeMore(content, printed, ctx)
	return next ? { ...m, content, printed: next } : { ...m, content }
}

export function chunksText(printed: readonly PrintedChunk[]): string {
	let text = ''
	for (const chunk of printed) text += chunk.text
	return text
}

const MARKER_LINE = /^\s*(?:[-*_+=](?:\s*[-*_+=])*|\d+[.)]?|#{1,6})\s*$/u
const HOLD_LIMIT = 300

/** Whole words only: the word still arriving waits for its space. */
function wholeWords(text: string, complete: boolean): string {
	if (complete || /\s$/u.test(text)) return text
	const at = text.search(/\s\S*$/u)
	return at < 0 ? '' : text.slice(0, at)
}

/** The text of a prose line as far as it is decided: whole words, no marker left open. */
function holdProse(text: string, ended: boolean): string {
	return held(wholeWords(text, ended))
}

function holdSegment(
	tail: string,
	r: BlockRange,
	hasAfter: boolean,
	state: TailState,
	first: boolean,
): string {
	const seg = tail.slice(r.start, r.end)
	const ended = tail[r.end] === '\n'
	switch (r.kind) {
		case 'code': {
			const lines = seg.split('\n')
			// An open fence is drawn as code, a line at a time: a line still being
			// typed, and a closing fence still being typed, wait for their ends.
			const whole = ended ? lines : lines.slice(0, -1)
			const opener = first && state.join === 'code' ? 0 : 1
			if (whole.length <= opener) return ''
			return whole.join('\n')
		}
		case 'table': {
			const lines = seg.split('\n')
			if (!ended && lines.length <= 2) return ''
			if (ended) return seg
			const row = (lines[lines.length - 1] ?? '').trim()
			const cells = (text: string) => text.replace(/^\||\|$/gu, '').split(/(?<!\\)\|/u).length
			const complete =
				row.endsWith('|') && !row.endsWith('\\|') && cells(row) >= cells(lines[0] ?? '')
			return (complete ? lines : lines.slice(0, -1)).join('\n')
		}
		case 'heading': {
			const m = LINE_SHAPES.heading.exec(seg)
			if (!m) return ''
			const at = seg.indexOf(m[2] ?? '', (m[1] ?? '').length)
			const text = holdProse(seg.slice(at), ended)
			return text.length > 0 ? seg.slice(0, at) + text : ''
		}
		case 'bullet': {
			const m = LINE_SHAPES.bullet.exec(seg)
			if (!m) return ''
			// Text that is itself only a marker may still turn the line into a rule.
			const kept = holdProse(m[3] ?? '', ended)
			const text = !ended && MARKER_LINE.test(kept) ? '' : kept
			return text.length > 0 ? seg.slice(0, seg.length - (m[3] ?? '').length) + text : ''
		}
		case 'quote': {
			const lines = seg.split('\n')
			const lastLine = lines[lines.length - 1] ?? ''
			const mark = LINE_SHAPES.quoteMark.exec(lastLine)?.[0] ?? ''
			const kept = holdProse(lastLine.slice(mark.length), ended)
			// A marker with no text after the quote mark may still become a rule or a list item.
			const content = !ended && MARKER_LINE.test(kept) ? '' : kept
			lines[lines.length - 1] = `${mark}${content}`
			return lines.join('\n')
		}
		case 'rule':
			// The reader sees a rule only when its line has ended, so the newline goes with it.
			return ended ? `${seg}\n` : seg
		default: {
			const lines = seg.split('\n')
			const total = lines.length
			const tailLine = lines[total - 1] ?? ''
			const pipe = (line: string | undefined) => /^\s*\|/u.test(line ?? '')
			if (!ended) {
				// The partly typed separator under a pipe line, and a line that may
				// still become a rule, a list marker, a heading or a separator, are not
				// drawn as the text they look like; a pipe line may become a header.
				if (
					total > 1 &&
					pipe(lines[total - 2]) &&
					tailLine.length > 0 &&
					/^[\s:|-]*$/u.test(tailLine)
				)
					lines.splice(total - 2, 2)
				else if (MARKER_LINE.test(tailLine) || pipe(tailLine)) lines.pop()
			} else if (pipe(tailLine) && !hasAfter) lines.pop()
			if (lines.length === 0) return ''
			const complete = ended || lines.length < total
			return held(wholeWords(lines.join('\n'), complete))
		}
	}
}

/** The text up to the first marker that is still open and could pair, with trailing space cut. */
function held(text: string): string {
	for (const k of openMarkersIn(text)) {
		const ch = text[k]
		const after = text.slice(k + 1)
		if (text.length - k > HOLD_LIMIT) continue
		let hold: boolean
		if (ch === '`') hold = true
		else if (ch === '[') {
			const close = after.indexOf(']')
			hold = close < 0 || close === after.length - 1 || after[close + 1] === '('
		} else hold = true
		if (hold) return text.slice(0, k).replace(/\s+$/u, '')
	}
	return text.replace(/\s+$/u, '')
}

/**
 * What of the tail may be drawn while the reply is still being written.
 *
 * The rule per construct (a held thing is not drawn at all, never drawn as the
 * source it will stop being):
 *
 * - prose (a paragraph, a list item, a heading, a quote): whole words; the
 *   word still arriving waits for its space;
 * - an opening `` ` ``, `[`, `**`, `*`, `__` or `_` that has not closed: the
 *   text from it on waits for its closer (the reader pairs a lone `*` with a
 *   later one wherever it stands, so a lone `*` waits too; a wait is let go
 *   after 300 characters, past which it is taken for a literal);
 * - a line of only `-`, `*`, `_`, `+`, `=`, digits (with `.` or `)`) or `#`,
 *   still arriving: waits until the line ends or text follows, since it may be
 *   a rule, a list marker, a heading or an underline;
 * - a fence opener line: waits for its end (it may be inline code); inside an
 *   open fence the code is drawn as code a line at a time;
 * - a table: its header waits for the separator line to end; then the header
 *   and every complete row are drawn and a half-written row waits;
 * - the end of the turn holds nothing: the caller draws the whole text.
 */
export function tailView(tail: string, state: TailState): string {
	const ranges = scanTail(tail, state)
	const last = ranges[ranges.length - 1]
	if (!last) return ''
	const hasAfter = tail.slice(last.end + 1).length > 0
	const body = holdSegment(tail, last, hasAfter, state, ranges.length === 1)
	if (body !== '') return tail.slice(0, last.start) + body
	const before = tail.slice(0, last.start).replace(/\s+$/u, '')
	// A rule before the part that is held keeps the line end that makes it a rule.
	return ranges[ranges.length - 2]?.kind === 'rule' ? `${before}\n` : before
}

/** The pieces a message is drawn from: printed chunks, then the live tail. */
export interface ReplyPiece {
	readonly text: string
	readonly join: 'block' | 'text' | 'code'
	readonly lang?: string
	readonly lead: MdBlockType | null
	readonly first: boolean
}

export function printedPieces(printed: readonly PrintedChunk[]): ReplyPiece[] {
	return printed.map((chunk, i) => {
		const before = printed[i - 1]
		return {
			// The newline that ended a code block's last line is not a line of its own;
			// the newline after a rule is what makes it one.
			text: chunk.last === 'code' ? chunk.text.replace(/\n$/u, '') : chunk.text,
			join: chunk.join,
			...(chunk.lang !== undefined ? { lang: chunk.lang } : {}),
			lead: before ? before.last : null,
			first: i === 0,
		}
	})
}

/**
 * The part of a reply that is not printed: the live tail while it streams, the
 * rest of it once it has finished. `undefined` when there is nothing to draw.
 */
export function tailPiece(message: TranscriptMessage): ReplyPiece | undefined {
	const printed = message.printed ?? []
	const base = chunksText(printed)
	// A reply whose text no longer begins with what was printed is drawn whole.
	const coherent = message.content.startsWith(base)
	const raw = coherent ? message.content.slice(base.length) : message.content
	const state = coherent ? tailStateOf(printed) : ({ join: 'block', lead: null } as TailState)
	const text = message.pending ? tailView(raw, state) : raw
	if (text.trim().length === 0) return undefined
	return {
		text,
		join: state.join,
		...(state.lang !== undefined ? { lang: state.lang } : {}),
		lead: state.lead,
		first: printed.length === 0 || !coherent,
	}
}

/** Said under a reply whose printed parts could not be taken back. */
export const DROPPED_REPLY_NOTICE = 'The reply above was dropped; the answer starts again below.'

/**
 * A reply whose request started over. One that has printed nothing is removed.
 * Parts already printed are in the scrollback and cannot be taken back: the
 * reply stays as written, ends where it was, and a notice says it was dropped,
 * so the screen does not read as the same answer twice.
 */
export function voidReply(
	messages: readonly TranscriptMessage[],
	abandoned: string,
	note: () => TranscriptMessage,
): TranscriptMessage[] {
	return messages.flatMap((m) =>
		m.id !== abandoned ? [m] : m.printed?.length ? [{ ...m, pending: false }, note()] : [],
	)
}
