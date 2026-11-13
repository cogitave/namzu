/**
 * The rows of a reply that is being written, kept as it grows.
 *
 * A reply is laid out again at every piece that arrives. Doing that from the
 * whole text each time made a reply of a megabyte cost the square of its length
 * (every piece parsed, scanned and laid out everything above it again) and kept
 * its rows in several forms at once. Here a reply keeps what is decided:
 *
 * - the blocks before the last one cannot change whatever arrives, so they are
 *   laid out once, into the rows of the window, and the text from there on is
 *   the only text read again;
 * - a code block is read a line at a time. The first stretch of it that the
 *   colouring may still change (`MAX_BLOCK_CHARS` characters) is made again as
 *   it grows; every line past that, or past a limit, is made once and kept as
 *   the row the window shows, and the text of the line is not kept.
 *
 * The rows are the ones the whole text gives. `reply-rows.test.ts` lays a corpus
 * out both ways at every position and requires the same rows, so the two cannot
 * drift apart unseen.
 *
 * A reply with a control character in it is laid out from the whole text, as it
 * always was: its display form is not the text, so offsets in one are not
 * offsets in the other.
 */

import { MAX_BLOCK_CHARS, colourLines, grammarState } from '../code-highlight.js'
import { type FenceOpener, closesFence, openingFence, stripFenceIndent } from '../markdown-fence.js'
import { blockGap, codeChars, codeIndent } from '../markdown-structure.js'
import { type MdBlock, parseMarkdown, scanBlockRanges } from '../markdownParser.js'
import { tailView } from '../stream-flow.js'
import { terminalDisplayText } from '../terminal-display.js'
import {
	type MarkdownRow,
	blocksRows,
	codeLineRows,
	codePad,
	keptLineRows,
	row,
} from './markdown-rows.js'
import type { FsRow } from './rows.js'

/** How a row of the reply is put into the window: its place among the rows of the message decides its gutter. */
export type RowWrap = (row: MarkdownRow, index: number) => FsRow

/**
 * A copy of `text` that holds nothing else alive. A slice of a string points into the string it
 * was cut from, and the reply's text is a new, longer string at every piece: a row whose text was
 * cut from it kept every one of those copies (a reply of 400 KB held about 80 MB that way).
 */
function detach(text: string): string {
	return text.length < 13 ? text : ` ${text}`.slice(1)
}

/** A code block the reply is in, read a line at a time. */
interface OpenCode {
	readonly opener: FenceOpener
	readonly lang: string | undefined
	/** Columns the fence was indented; the lines lose them. */
	readonly stripped: number
	/** Columns the block is drawn at. */
	readonly indent: number
	/** Characters of fenced code in the reply before the block. */
	readonly spentBefore: number
	/** Where the next unread line starts. */
	at: number
	/** Lines read. */
	lines: number
	/** Characters read, a line and its break each counted. */
	chars: number
	/** The leading lines the colouring may still change. */
	readonly head: string[]
	headChars: number
	/** Counted up at every line the head takes, so that what depends on it is made again. */
	headVersion: number
	/** Lines of the head that carry colour, as of the last read. */
	coloured: number
	/** Rows of the lines before `coloured`, made for `volatileFor`. */
	volatile: FsRow[]
	volatileFor: number
	/** Rows of the lines from `coloured` on: made once. */
	fixed: FsRow[]
}

export class ReplyRows {
	/** The text last handed in: the next one must begin with it. */
	private seen = ''
	/** Where the text not yet laid out for good begins: always at the start of a block. */
	private pos = 0
	/** Rows of the blocks before `pos`, in the form the window holds them. */
	private done: FsRow[] = []
	/** The type of the last block before `pos`, for the blank row between blocks. */
	private prev: string | undefined
	/** Characters of fenced code before `pos`. */
	private spent = 0
	private code: OpenCode | null = null
	private ended = false
	/** A reply with a control character in it is not laid out here. */
	private broken = false
	/** Rows of the last block, still open. */
	private openRows: FsRow[] = []

	constructor(
		private readonly width: number,
		private readonly color: string,
		private readonly wrap: RowWrap,
	) {}

	/** Whether this reply can be laid out here at all. */
	get usable(): boolean {
		return !this.broken
	}

	/** Rows held for good, and rows of the open block: what is kept, for the tests that count it. */
	get kept(): { settled: number; open: number } {
		return { settled: this.done.length, open: this.openRows.length }
	}

	/**
	 * The rows of `content`: the text as far as it is decided while the reply is
	 * pending, the whole of it once it is `complete`. `undefined` when this reply
	 * has to be laid out from the whole text.
	 */
	update(content: string, complete: boolean): FsRow[] | undefined {
		if (this.broken) return undefined
		if (this.ended || !content.startsWith(this.seen)) this.reset()
		const fresh = content.slice(this.seen.length)
		if (fresh.length > 0 && terminalDisplayText(fresh) !== fresh) {
			this.broken = true
			this.reset()
			return undefined
		}
		this.seen = content
		this.advance(content, complete)
		if (complete) this.ended = true
		return this.openRows.length > 0 ? this.done.concat(this.openRows) : this.done.slice()
	}

	private reset(): void {
		this.seen = ''
		this.pos = 0
		this.done = []
		this.prev = undefined
		this.spent = 0
		this.code = null
		this.ended = false
		this.openRows = []
	}

	private put(rows: readonly MarkdownRow[], into: FsRow[], base: number): void {
		for (const made of rows) into.push(this.wrap(made, base + into.length))
	}

	/** Lay out the blocks of `text`, which end at a block boundary, for good. */
	private settle(text: string): void {
		const blocks = parseMarkdown(text)
		if (blocks.length === 0) return
		this.put(blocksRows(blocks, this.width, this.color, false, this.spent, this.prev), this.done, 0)
		for (const block of blocks) this.spent += codeChars(block)
		this.prev = blocks[blocks.length - 1]?.type
	}

	private advance(content: string, complete: boolean): void {
		this.openRows = []
		for (;;) {
			if (this.code) {
				if (!this.readCode(content, complete)) return
				continue
			}
			const rest = content.slice(this.pos)
			const ranges = scanBlockRanges(rest)
			const last = ranges[ranges.length - 1]
			if (!last) return
			if (last.start > 0) {
				this.settle(detach(rest.slice(0, last.start)))
				this.pos += last.start
			}
			if (last.kind === 'code') {
				const at = content.indexOf('\n', this.pos)
				// The line of the fence waits for its end: until then it may be inline code.
				const opener = at >= 0 ? openingFence(content.slice(this.pos, at)) : null
				if (opener) {
					this.openCode(opener, at + 1)
					continue
				}
			}
			const tail = content.slice(this.pos)
			const shown = complete ? tail : tailView(tail, { join: 'block', lead: null })
			const blocks = parseMarkdown(shown)
			this.put(
				blocksRows(blocks, this.width, this.color, false, this.spent, this.prev),
				this.openRows,
				this.done.length,
			)
			return
		}
	}

	private openCode(opener: FenceOpener, at: number): void {
		grammarState(opener.lang)
		this.code = {
			opener,
			lang: opener.lang,
			stripped: opener.indent,
			indent: codeIndent({ indent: opener.indent }, this.width),
			spentBefore: this.spent,
			at,
			lines: 0,
			chars: 0,
			head: [],
			headChars: 0,
			headVersion: 0,
			coloured: 0,
			volatile: [],
			volatileFor: -1,
			fixed: [],
		}
	}

	/**
	 * Read the lines of the open block that have arrived. True when the block has
	 * ended and the text after it is next; false when it is still open, with its
	 * rows in `openRows`.
	 */
	private readCode(content: string, complete: boolean): boolean {
		const code = this.code as OpenCode
		const added: { n: number; line: string }[] = []
		let closed = false
		let next = code.at
		for (;;) {
			const nl = content.indexOf('\n', next)
			if (nl < 0 && !complete) break
			const line = nl < 0 ? content.slice(next) : content.slice(next, nl)
			if (closesFence(line, code.opener)) {
				closed = true
				next = nl < 0 ? content.length : nl + 1
				break
			}
			const text = detach(stripFenceIndent(line, code.stripped))
			added.push({ n: code.lines, line: text })
			code.lines += 1
			code.chars += text.length + 1
			if (code.headChars + text.length + 1 <= MAX_BLOCK_CHARS) {
				code.head.push(text)
				code.headChars += text.length + 1
				code.headVersion += 1
			}
			if (nl < 0) {
				next = content.length
				closed = true
				break
			}
			next = nl + 1
		}
		code.at = next
		this.colour(code, added)
		if (code.lines === 0 && !closed) return false
		const rows: FsRow[] = []
		const base = this.done.length
		if (code.lines === 0) {
			// A fence with nothing in it, closed: the block the whole text gives.
			const empty: MdBlock = {
				type: 'code',
				...(code.lang ? { lang: code.lang } : {}),
				...(code.opener.indent > 0 ? { indent: code.opener.indent } : {}),
				lines: [],
			}
			this.put(
				blocksRows([empty], this.width, this.color, false, this.spent, this.prev),
				rows,
				base,
			)
		} else {
			if (this.gapAbove(code)) this.put([row([])], rows, base)
			for (const made of code.volatile) rows.push(made)
			for (const made of code.fixed) rows.push(made)
		}
		if (!closed) {
			this.openRows = rows
			return false
		}
		for (const made of rows) this.done.push(made)
		this.spent += code.chars
		this.prev = 'code'
		this.pos = next
		this.code = null
		return true
	}

	/**
	 * Colour what the library may still change, and make the rows of what it may not.
	 * `added` are the lines that arrived since the last read, in order.
	 */
	private colour(code: OpenCode, added: readonly { n: number; line: string }[]): void {
		const room = this.width - code.indent
		const pad = codePad(code.indent)
		const first = this.done.length + (this.gapAbove(code) ? 1 : 0)
		const into = (rows: readonly MarkdownRow[], rowsOf: FsRow[]): void => {
			for (const made of rows) rowsOf.push(this.wrap(made, first + rowsOf.length))
		}
		if (code.volatileFor !== code.headVersion) {
			const coloured = colourLines(code.lang, code.head, {
				above: '',
				block: 0,
				spent: code.spentBefore,
			})?.lines
			code.coloured = coloured?.length ?? 0
			// The lines before `coloured` are made again for the head they were read with.
			const rows: FsRow[] = []
			for (let n = 0; n < code.coloured; n++)
				into(keptLineRows(code.head[n] as string, coloured?.[n], room, code.indent, pad), rows)
			code.volatile = rows
			code.volatileFor = code.headVersion
		}
		for (const { n, line } of added) {
			if (n < code.coloured) continue
			const rows = codeLineRows(line, undefined, room, code.indent, pad)
			for (const made of rows)
				code.fixed.push(this.wrap(made, first + code.volatile.length + code.fixed.length))
		}
	}

	/** Whether a blank row stands between the block before and this one. */
	private gapAbove(code: OpenCode): boolean {
		return blockGap({ type: 'code', indent: code.opener.indent }, this.prev) === 1
	}
}
