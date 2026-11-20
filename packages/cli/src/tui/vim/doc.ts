/**
 * The draft as a list of characters, for the vim keys.
 *
 * Every position here is an index into the list of characters (one entry per
 * grapheme, so an emoji or an accented letter is one step), and `offs` turns an
 * index back into a UTF-16 offset in the text. Nothing in this file knows
 * about React or the terminal.
 */

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

const WORD = /^[\p{L}\p{N}\p{M}_]+$/u
const SPACE = /\s/u

/** What a character is for the word keys. */
export type CharClass = 'newline' | 'space' | 'word' | 'punct'

export function charClass(ch: string, big: boolean): CharClass {
	if (ch === '\n') return 'newline'
	if (SPACE.test(ch)) return 'space'
	if (big) return 'word'
	return WORD.test(ch) ? 'word' : 'punct'
}

export class Doc {
	readonly text: string
	readonly chars: readonly string[]
	/** `offs[i]` is where character `i` starts in `text`; `offs[n]` is the text's length. */
	readonly offs: readonly number[]

	constructor(text: string) {
		this.text = text
		const chars: string[] = []
		const offs: number[] = []
		for (const segment of segmenter.segment(text)) {
			chars.push(segment.segment)
			offs.push(segment.index)
		}
		offs.push(text.length)
		this.chars = chars
		this.offs = offs
	}

	get n(): number {
		return this.chars.length
	}

	/** The index of the character holding `offset`; `n` for the end of the text. */
	idx(offset: number): number {
		if (offset >= this.text.length) return this.n
		let low = 0
		let high = this.n - 1
		while (low < high) {
			const mid = (low + high + 1) >> 1
			if ((this.offs[mid] as number) <= offset) low = mid
			else high = mid - 1
		}
		return low
	}

	off(index: number): number {
		return this.offs[Math.max(0, Math.min(index, this.n))] as number
	}

	slice(from: number, to: number): string {
		return this.text.slice(this.off(from), this.off(to))
	}

	/** The first index of the line holding `i`. */
	lineStart(i: number): number {
		let at = Math.min(i, this.n)
		while (at > 0 && this.chars[at - 1] !== '\n') at -= 1
		return at
	}

	/** The index of the newline that ends the line holding `i`, or `n`. */
	lineEnd(i: number): number {
		let at = Math.max(0, i)
		while (at < this.n && this.chars[at] !== '\n') at += 1
		return at
	}

	/** Which line (0-based) `i` is on. */
	lineOf(i: number): number {
		let line = 0
		const stop = Math.min(i, this.n)
		for (let at = 0; at < stop; at += 1) if (this.chars[at] === '\n') line += 1
		return line
	}

	get lineCount(): number {
		let lines = 1
		for (const ch of this.chars) if (ch === '\n') lines += 1
		return lines
	}

	/** The first index of line `line` (0-based), clamped to the last line. */
	startOfLine(line: number): number {
		let remaining = Math.max(0, line)
		let at = 0
		while (remaining > 0) {
			const end = this.lineEnd(at)
			if (end >= this.n) return at
			at = end + 1
			remaining -= 1
		}
		return at
	}

	firstNonBlank(i: number): number {
		const start = this.lineStart(i)
		const end = this.lineEnd(i)
		let at = start
		while (at < end && charClass(this.chars[at] as string, false) === 'space') at += 1
		return at < end ? at : Math.max(start, end - 1)
	}

	/** Where a NORMAL-mode cursor may rest: on a character, never past the last one of its line. */
	normal(i: number): number {
		const start = this.lineStart(i)
		const end = this.lineEnd(i)
		if (end === start) return start
		return Math.min(i, end - 1)
	}

	isEmptyLine(i: number): boolean {
		return this.lineStart(i) === this.lineEnd(i)
	}
}

// ---- word motions ----

function cls(doc: Doc, i: number, big: boolean): CharClass {
	return charClass(doc.chars[i] as string, big)
}

/** `w` / `W`: the start of the next word, an empty line counting as one. */
export function nextWordStart(doc: Doc, from: number, big: boolean): number {
	const n = doc.n
	let i = from
	if (i >= n) return n
	const start = cls(doc, i, big)
	if (start === 'word' || start === 'punct') {
		while (i < n && cls(doc, i, big) === start) i += 1
	}
	while (i < n) {
		const c = cls(doc, i, big)
		if (c === 'space') {
			i += 1
		} else if (c === 'newline') {
			i += 1
			if (i < n && doc.chars[i] === '\n') return i
		} else break
	}
	return i
}

/** `e` / `E`: the last character of this word, or of the next when already on the last one. */
export function wordEnd(doc: Doc, from: number, big: boolean): number {
	const n = doc.n
	if (n === 0) return 0
	let i = from + 1
	while (i < n && (cls(doc, i, big) === 'space' || cls(doc, i, big) === 'newline')) i += 1
	if (i >= n) return n - 1
	const c = cls(doc, i, big)
	while (i + 1 < n && cls(doc, i + 1, big) === c) i += 1
	return i
}

/** The last character of the word under `from`, without moving on (the `cw` rule). */
export function currentWordEnd(doc: Doc, from: number, big: boolean): number {
	const c = cls(doc, from, big)
	let i = from
	while (i + 1 < doc.n && cls(doc, i + 1, big) === c) i += 1
	return i
}

/** `b` / `B`: the start of this word, or of the previous when already on its first character. */
export function prevWordStart(doc: Doc, from: number, big: boolean): number {
	if (from <= 0) return 0
	let i = from - 1
	const emptyLine = (at: number): boolean =>
		doc.chars[at] === '\n' && (at === 0 || doc.chars[at - 1] === '\n')
	while (i > 0) {
		const c = cls(doc, i, big)
		if (c === 'space') i -= 1
		else if (c === 'newline' && !emptyLine(i)) i -= 1
		else break
	}
	const c = cls(doc, i, big)
	if (c === 'newline' || c === 'space') return i
	while (i > 0 && cls(doc, i - 1, big) === c) i -= 1
	return i
}

// ---- finding a character on the line ----

export type FindKind = 'f' | 'F' | 't' | 'T'

/** `f`, `F`, `t`, `T`: the index to land on, or null. `again` is a repeat with `;` or `,`. */
export function findChar(
	doc: Doc,
	from: number,
	kind: FindKind,
	char: string,
	count: number,
	again: boolean,
): number | null {
	const start = doc.lineStart(from)
	const end = doc.lineEnd(from)
	let remaining = count
	if (kind === 'f' || kind === 't') {
		let i = from + 1 + (again && kind === 't' ? 1 : 0)
		for (; i < end; i += 1) {
			if (doc.chars[i] === char && --remaining === 0) return kind === 'f' ? i : i - 1
		}
		return null
	}
	let i = from - 1 - (again && kind === 'T' ? 1 : 0)
	for (; i >= start; i -= 1) {
		if (doc.chars[i] === char && --remaining === 0) return kind === 'F' ? i : i + 1
	}
	return null
}

const OPENING = '([{'
const CLOSING = ')]}'

/** `%`: the bracket matching the first one at or after `from` on its line. */
export function matchBracket(doc: Doc, from: number): number | null {
	const end = doc.lineEnd(from)
	let at = from
	while (at < end && !(OPENING + CLOSING).includes(doc.chars[at] as string)) at += 1
	if (at >= end) return null
	const ch = doc.chars[at] as string
	const open = OPENING.indexOf(ch)
	if (open >= 0) {
		const close = CLOSING[open] as string
		let depth = 0
		for (let i = at + 1; i < doc.n; i += 1) {
			const here = doc.chars[i]
			if (here === ch) depth += 1
			else if (here === close) {
				if (depth === 0) return i
				depth -= 1
			}
		}
		return null
	}
	const opener = OPENING[CLOSING.indexOf(ch)] as string
	let depth = 0
	for (let i = at - 1; i >= 0; i -= 1) {
		const here = doc.chars[i]
		if (here === ch) depth += 1
		else if (here === opener) {
			if (depth === 0) return i
			depth -= 1
		}
	}
	return null
}

// ---- text objects ----

/** A half-open range of indices. */
export type Span = readonly [number, number]

export function wordObject(
	doc: Doc,
	at: number,
	big: boolean,
	inner: boolean,
	count: number,
): Span | null {
	const n = doc.n
	if (n === 0 || at >= n) return null
	if (doc.chars[at] === '\n') return [at, at]
	const runStart = (j: number): number => {
		const c = cls(doc, j, big)
		let s = j
		while (s > 0 && cls(doc, s - 1, big) === c) s -= 1
		return s
	}
	const runEnd = (j: number): number => {
		const c = cls(doc, j, big)
		let e = j
		while (e < n && cls(doc, e, big) === c) e += 1
		return e
	}
	const skipSpaces = (j: number): number => {
		let e = j
		while (e < n && cls(doc, e, big) === 'space') e += 1
		return e
	}
	let start = runStart(at)
	let end = runEnd(at)
	if (inner) {
		for (let k = 1; k < count; k += 1) {
			if (end >= n || doc.chars[end] === '\n') break
			end = runEnd(end)
		}
		return [start, end]
	}
	const onSpace = cls(doc, at, big) === 'space'
	if (onSpace) {
		if (end < n && doc.chars[end] !== '\n') end = runEnd(end)
	} else {
		const trailing = skipSpaces(end)
		if (trailing > end) end = trailing
		else {
			const lineBegin = doc.lineStart(start)
			let lead = start
			while (lead > lineBegin && cls(doc, lead - 1, big) === 'space') lead -= 1
			start = lead
		}
	}
	for (let k = 1; k < count; k += 1) {
		if (end >= n || doc.chars[end] === '\n') break
		end = skipSpaces(runEnd(end))
	}
	return [start, end]
}

export function quoteObject(doc: Doc, at: number, quote: string, inner: boolean): Span | null {
	const start = doc.lineStart(at)
	const end = doc.lineEnd(at)
	const marks: number[] = []
	for (let i = start; i < end; i += 1) {
		if (doc.chars[i] !== quote) continue
		let slashes = 0
		for (let j = i - 1; j >= start && doc.chars[j] === '\\'; j -= 1) slashes += 1
		if (slashes % 2 === 0) marks.push(i)
	}
	let pair: [number, number] | null = null
	for (let k = 0; k + 1 < marks.length; k += 2) {
		const open = marks[k] as number
		const close = marks[k + 1] as number
		if (at <= close) {
			pair = [open, close]
			break
		}
	}
	if (!pair) return null
	if (inner) return [pair[0] + 1, pair[1]]
	let stop = pair[1] + 1
	let begin = pair[0]
	if (stop < end && cls(doc, stop, false) === 'space') {
		while (stop < end && cls(doc, stop, false) === 'space') stop += 1
	} else {
		while (begin > start && cls(doc, begin - 1, false) === 'space') begin -= 1
	}
	return [begin, stop]
}

export function bracketObject(
	doc: Doc,
	at: number,
	open: string,
	close: string,
	inner: boolean,
	count: number,
): Span | null {
	const enclosing = (from: number, skipSelf: boolean): number => {
		let depth = 0
		for (let j = from; j >= 0; j -= 1) {
			const ch = doc.chars[j]
			if (ch === close && !(skipSelf && j === from)) depth += 1
			else if (ch === open) {
				if (depth === 0) return j
				depth -= 1
			}
		}
		return -1
	}
	let s = enclosing(Math.min(at, doc.n - 1), true)
	for (let k = 1; k < count && s > 0; k += 1) {
		const outer = enclosing(s - 1, false)
		if (outer < 0) return null
		s = outer
	}
	if (s < 0) return null
	let depth = 0
	let e = -1
	for (let j = s + 1; j < doc.n; j += 1) {
		const ch = doc.chars[j]
		if (ch === open) depth += 1
		else if (ch === close) {
			if (depth === 0) {
				e = j
				break
			}
			depth -= 1
		}
	}
	if (e < 0) return null
	return inner ? [s + 1, e] : [s, e + 1]
}

/** The text object a key names: `w W " ' \` ( ) b [ ] { } B < >`. */
export function textObject(
	doc: Doc,
	at: number,
	obj: string,
	inner: boolean,
	count: number,
): Span | null {
	switch (obj) {
		case 'w':
			return wordObject(doc, at, false, inner, count)
		case 'W':
			return wordObject(doc, at, true, inner, count)
		case '"':
		case "'":
		case '`':
			return quoteObject(doc, at, obj, inner)
		case '(':
		case ')':
		case 'b':
			return bracketObject(doc, at, '(', ')', inner, count)
		case '[':
		case ']':
			return bracketObject(doc, at, '[', ']', inner, count)
		case '{':
		case '}':
		case 'B':
			return bracketObject(doc, at, '{', '}', inner, count)
		case '<':
		case '>':
			return bracketObject(doc, at, '<', '>', inner, count)
		default:
			return null
	}
}

export const TEXT_OBJECT_KEYS = 'wW"\'`()b[]{}B<>'
