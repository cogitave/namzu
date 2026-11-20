/**
 * The vim keys for the message box, as a pure state machine.
 *
 * `vimKey` takes the machine's state, the draft and the cursor, and one key,
 * and returns the new state, the new draft and cursor, and anything the host
 * has to do that the draft alone cannot say (undo, step through history).
 * It knows nothing of React or the terminal; the composer feeds it keys and
 * applies what comes back.
 *
 * Modes: INSERT (the composer's own keys type; only Esc is read here), NORMAL,
 * VISUAL and VISUAL LINE. One unnamed register holds the last deleted, changed
 * or yanked text. `.` repeats the last change, counts go up to 10000.
 *
 * Offsets are UTF-16 positions in the draft; the cursor in NORMAL and VISUAL
 * rests on a character, never past the last one of its line.
 */
import {
	Doc,
	type FindKind,
	TEXT_OBJECT_KEYS,
	charClass,
	currentWordEnd,
	findChar,
	matchBracket,
	nextWordStart,
	prevWordStart,
	textObject,
	wordEnd,
} from './doc.js'

export type VimMode = 'INSERT' | 'NORMAL' | 'VISUAL' | 'VISUAL LINE'

export const MAX_COUNT = 10000

/**
 * A key as the machine reads it: one printable character, or one of the names
 * `Escape`, `Enter`, `Backspace`, `Delete`, `Left`, `Right`, `Up`, `Down`.
 */
export interface VimKey {
	readonly key: string
	readonly ctrl?: boolean
	readonly meta?: boolean
}

export interface VimRegister {
	readonly text: string
	/** The text is whole lines: it ends in a newline and pastes as lines. */
	readonly linewise: boolean
}

/** Something the host does that the draft cannot express. */
export type VimEffect = 'undo' | 'history-up' | 'history-down' | 'history-search'

type Op = 'd' | 'c' | 'y' | '<' | '>'

interface Motion {
	readonly key: string
	readonly char?: string
}

type Target =
	| { readonly t: 'double' }
	| { readonly t: 'motion'; readonly motion: Motion }
	| { readonly t: 'obj'; readonly inner: boolean; readonly obj: string }

type Cmd =
	| { readonly t: 'motion'; readonly count: number | null; readonly motion: Motion }
	| { readonly t: 'simple'; readonly count: number | null; readonly key: string }
	| { readonly t: 'replace'; readonly count: number | null; readonly char: string }
	| {
			readonly t: 'vobj'
			readonly count: number | null
			readonly inner: boolean
			readonly obj: string
	  }
	| {
			readonly t: 'op'
			readonly op: Op
			readonly count: number | null
			readonly count2: number | null
			readonly target: Target
	  }

interface InsertSession {
	/** The draft and cursor where typing began, to tell what was typed. */
	readonly baseText: string
	readonly baseCursor: number
	/** `3ix<Esc>` types the text three times. */
	readonly repeat: number
	/** The command that started the insert, remembered for `.` once the text is known. */
	readonly change: Cmd | null
}

export interface VimState {
	readonly mode: VimMode
	/** The keys of a command still being typed (`2d`, `g`, `f`). */
	readonly pending: readonly string[]
	readonly register: VimRegister
	readonly lastFind: { readonly kind: FindKind; readonly char: string } | null
	/** The column `j` and `k` aim for; `Infinity` after `$`. */
	readonly wanted: number | null
	/** Where VISUAL began, as an offset. */
	readonly anchor: number
	readonly lastChange: { readonly cmd: Cmd; readonly insert: string } | null
	readonly insert: InsertSession | null
}

export interface VimResult {
	/** False: the key is not the machine's and goes on to the composer's own handling. */
	readonly handled: boolean
	readonly state: VimState
	readonly text: string
	readonly cursor: number
	readonly effects: readonly VimEffect[]
	/** The text that came in is text pasted from the register, not typed. */
	readonly pasted: boolean
}

export function createVimState(): VimState {
	return {
		mode: 'INSERT',
		pending: [],
		register: { text: '', linewise: false },
		lastFind: null,
		wanted: null,
		anchor: 0,
		lastChange: null,
		insert: null,
	}
}

/** A fresh prompt, as after a send: INSERT, nothing half typed. The register and `.` stay. */
export function resetVim(state: VimState): VimState {
	return { ...state, mode: 'INSERT', pending: [], wanted: null, insert: null }
}

/** Whether Esc belongs to the machine: anything but an idle NORMAL. */
export function vimOwnsEscape(state: VimState): boolean {
	return state.mode !== 'NORMAL' || state.pending.length > 0
}

/** The half-open offsets VISUAL has selected, or null outside VISUAL. */
export function vimSelection(
	state: VimState,
	text: string,
	cursor: number,
): readonly [number, number] | null {
	if (state.mode !== 'VISUAL' && state.mode !== 'VISUAL LINE') return null
	const doc = new Doc(text)
	if (doc.n === 0) return [0, 0]
	const a = Math.min(doc.idx(state.anchor), doc.n - 1)
	const c = Math.min(doc.idx(cursor), doc.n - 1)
	const low = Math.min(a, c)
	const high = Math.max(a, c)
	if (state.mode === 'VISUAL LINE') return [doc.off(doc.lineStart(low)), doc.off(doc.lineEnd(high))]
	return [doc.off(low), doc.off(high + 1)]
}

// ---- parsing a command from its keys ----

type Parse =
	| { readonly s: 'incomplete' }
	| { readonly s: 'invalid' }
	| { readonly s: 'ok'; readonly cmd: Cmd }

const NAMED = new Set([
	'Escape',
	'Enter',
	'Backspace',
	'Delete',
	'Left',
	'Right',
	'Up',
	'Down',
	'BS',
])
const OPS = new Set(['d', 'c', 'y', '<', '>'])
const MOTION_KEYS = new Set(['h', 'l', 'j', 'k', 'w', 'W', 'b', 'B', 'e', 'E', '0', '^', '$', 'G'])
const MOTION_EXTRA = new Set([';', ',', '%', ' ', 'BS'])
const CHAR_MOTIONS = new Set(['f', 'F', 't', 'T'])
const NORMAL_SIMPLE = new Set([
	'i',
	'I',
	'a',
	'A',
	'o',
	'O',
	'x',
	's',
	'S',
	'D',
	'C',
	'Y',
	'p',
	'P',
	'J',
	'~',
	'u',
	'.',
	'v',
	'V',
	'/',
])
const VISUAL_SIMPLE = new Set([
	'd',
	'x',
	'y',
	'c',
	's',
	'~',
	'u',
	'U',
	'>',
	'<',
	'J',
	'p',
	'P',
	'Y',
	'X',
	'D',
	'C',
	'S',
	'R',
	'o',
	'v',
	'V',
])

const isChar = (key: string | undefined): key is string => key !== undefined && !NAMED.has(key)

function parseMotion(
	keys: readonly string[],
	at: number,
): { readonly motion: Motion; readonly next: number } | 'incomplete' | null {
	const k = keys[at]
	if (k === undefined) return 'incomplete'
	if (k === 'g') {
		const k2 = keys[at + 1]
		if (k2 === undefined) return 'incomplete'
		return k2 === 'g' || k2 === 'j' || k2 === 'k'
			? { motion: { key: `g${k2}` }, next: at + 2 }
			: null
	}
	if (CHAR_MOTIONS.has(k)) {
		const c = keys[at + 1]
		if (c === undefined) return 'incomplete'
		return isChar(c) ? { motion: { key: k, char: c }, next: at + 2 } : null
	}
	if (MOTION_KEYS.has(k) || MOTION_EXTRA.has(k)) return { motion: { key: k }, next: at + 1 }
	return null
}

function parseCommand(keys: readonly string[], visual: boolean): Parse {
	let i = 0
	const readCount = (): number | null => {
		let count: number | null = null
		while (i < keys.length) {
			const key = keys[i] as string
			if (!/^[0-9]$/.test(key) || (key === '0' && count === null)) break
			count = Math.min((count ?? 0) * 10 + Number(key), MAX_COUNT)
			i += 1
		}
		return count
	}
	const count = readCount()
	const k = keys[i]
	if (k === undefined) return { s: 'incomplete' }
	if (visual) {
		if (k === 'r') {
			const c = keys[i + 1]
			if (c === undefined) return { s: 'incomplete' }
			return isChar(c) ? { s: 'ok', cmd: { t: 'replace', count, char: c } } : { s: 'invalid' }
		}
		if (k === 'i' || k === 'a') {
			const obj = keys[i + 1]
			if (obj === undefined) return { s: 'incomplete' }
			return TEXT_OBJECT_KEYS.includes(obj) && obj.length === 1
				? { s: 'ok', cmd: { t: 'vobj', count, inner: k === 'i', obj } }
				: { s: 'invalid' }
		}
		if (VISUAL_SIMPLE.has(k)) return { s: 'ok', cmd: { t: 'simple', count, key: k } }
	} else {
		if (OPS.has(k)) {
			i += 1
			const count2 = readCount()
			const k2 = keys[i]
			if (k2 === undefined) return { s: 'incomplete' }
			const op = k as Op
			if (k2 === k) return { s: 'ok', cmd: { t: 'op', op, count, count2, target: { t: 'double' } } }
			if (k2 === 'i' || k2 === 'a') {
				const obj = keys[i + 1]
				if (obj === undefined) return { s: 'incomplete' }
				return TEXT_OBJECT_KEYS.includes(obj) && obj.length === 1
					? {
							s: 'ok',
							cmd: { t: 'op', op, count, count2, target: { t: 'obj', inner: k2 === 'i', obj } },
						}
					: { s: 'invalid' }
			}
			const parsed = parseMotion(keys, i)
			if (parsed === 'incomplete') return { s: 'incomplete' }
			// `;` and `,` repeat a find; they are not something an operator can run over.
			if (!parsed || parsed.motion.key === ';' || parsed.motion.key === ',') return { s: 'invalid' }
			return {
				s: 'ok',
				cmd: { t: 'op', op, count, count2, target: { t: 'motion', motion: parsed.motion } },
			}
		}
		if (k === 'r') {
			const c = keys[i + 1]
			if (c === undefined) return { s: 'incomplete' }
			return isChar(c) ? { s: 'ok', cmd: { t: 'replace', count, char: c } } : { s: 'invalid' }
		}
		if (NORMAL_SIMPLE.has(k)) return { s: 'ok', cmd: { t: 'simple', count, key: k } }
	}
	const parsed = parseMotion(keys, i)
	if (parsed === 'incomplete') return { s: 'incomplete' }
	if (!parsed) return { s: 'invalid' }
	return { s: 'ok', cmd: { t: 'motion', count, motion: parsed.motion } }
}

/** A change `.` can repeat. */
function isChange(cmd: Cmd): boolean {
	if (cmd.t === 'op') return cmd.op !== 'y'
	if (cmd.t === 'replace') return true
	if (cmd.t === 'simple') return 'ixsSDCpPJ~aAoO'.includes(cmd.key) && cmd.key.length === 1
	return false
}

function withCount(cmd: Cmd, count: number): Cmd {
	if (cmd.t === 'op') return { ...cmd, count, count2: null }
	if (cmd.t === 'motion' || cmd.t === 'simple' || cmd.t === 'replace' || cmd.t === 'vobj')
		return { ...cmd, count }
	return cmd
}

// ---- the machine ----

interface Moved {
	/** Character index to land on. */
	readonly to: number
	readonly kind: 'excl' | 'incl' | 'line'
	readonly wanted?: number
}

/** A marker in the draft, as `[start, end)` offsets into the text. */
export interface VimChip {
	readonly start: number
	readonly end: number
}

const cap = (n: number): number => Math.min(n, MAX_COUNT)

class Machine {
	text: string
	cursor: number
	mode: VimMode
	pending: readonly string[]
	register: VimRegister
	lastFind: VimState['lastFind']
	wanted: number | null
	anchor: number
	lastChange: VimState['lastChange']
	insert: InsertSession | null
	effects: VimEffect[] = []
	pasted = false
	handled = true
	/** The text is being replayed by `.`, with this typed text for any insert. */
	private replay: string | null = null
	private docCache: Doc | null = null
	/** Pasted-text and image markers, as `[start, end)` offsets into the text: each is one unit. */
	private readonly chips: readonly VimChip[]

	constructor(state: VimState, text: string, cursor: number, chips: readonly VimChip[] = []) {
		this.chips = chips
		this.text = text
		this.cursor = cursor
		this.mode = state.mode
		this.pending = state.pending
		this.register = state.register
		this.lastFind = state.lastFind
		this.wanted = state.wanted
		this.anchor = state.anchor
		this.lastChange = state.lastChange
		this.insert = state.insert
	}

	get doc(): Doc {
		if (!this.docCache || this.docCache.text !== this.text) this.docCache = new Doc(this.text)
		return this.docCache
	}

	get ci(): number {
		return this.doc.idx(this.cursor)
	}

	/** Put the cursor on character `i`. */
	at(i: number): void {
		this.cursor = this.doc.off(i)
	}

	/** Replace characters `[from, to)` with `replacement`. */
	splice(from: number, to: number, replacement: string): void {
		const doc = this.doc
		this.text = doc.text.slice(0, doc.off(from)) + replacement + doc.text.slice(doc.off(to))
		this.wanted = null
	}

	state(): VimState {
		return {
			mode: this.mode,
			pending: this.pending,
			register: this.register,
			lastFind: this.lastFind,
			wanted: this.wanted,
			anchor: this.anchor,
			lastChange: this.lastChange,
			insert: this.insert,
		}
	}

	result(): VimResult {
		if (this.mode === 'NORMAL' || this.mode === 'VISUAL' || this.mode === 'VISUAL LINE') {
			this.at(this.doc.normal(this.ci))
		}
		return {
			handled: this.handled,
			state: this.state(),
			text: this.text,
			cursor: this.cursor,
			effects: this.effects,
			pasted: this.pasted,
		}
	}

	// -- modes --

	enterInsert(repeat: number, cmd: Cmd | null): void {
		if (this.replay !== null) {
			const typed = this.replay
			if (typed.length > 0) {
				const at = this.ci
				this.splice(at, at, typed.repeat(repeat))
				this.cursor += typed.length * repeat
			}
			this.leaveInsertCursor()
			this.mode = 'NORMAL'
			return
		}
		this.mode = 'INSERT'
		this.pending = []
		this.wanted = null
		this.insert = {
			baseText: this.text,
			baseCursor: this.cursor,
			repeat,
			change: cmd !== null && isChange(cmd) ? cmd : null,
		}
	}

	/** The cursor's step back as INSERT ends, unless it is at the start of a line. */
	leaveInsertCursor(): void {
		if (this.cursor > 0 && this.text[this.cursor - 1] !== '\n') {
			const doc = this.doc
			this.at(Math.max(0, doc.idx(this.cursor) - 1))
		}
	}

	exitInsert(): void {
		// Text typed in INSERT moved the cursor: the column `j` and `k` aimed for is stale.
		this.wanted = null
		const session = this.insert
		let typed = ''
		if (session) {
			const prefix = session.baseText.slice(0, session.baseCursor)
			const suffix = session.baseText.slice(session.baseCursor)
			if (
				this.text.startsWith(prefix) &&
				this.text.endsWith(suffix) &&
				this.text.length >= prefix.length + suffix.length
			) {
				typed = this.text.slice(prefix.length, this.text.length - suffix.length)
			}
			if (typed.length > 0 && session.repeat > 1) {
				const at = this.ci
				this.splice(at, at, typed.repeat(session.repeat - 1))
				this.cursor += typed.length * (session.repeat - 1)
			}
			if (session.change) this.lastChange = { cmd: session.change, insert: typed }
		}
		this.insert = null
		this.mode = 'NORMAL'
		this.pending = []
		this.leaveInsertCursor()
	}

	exitVisual(): void {
		this.mode = 'NORMAL'
		this.pending = []
	}

	remember(cmd: Cmd): void {
		if (this.replay === null && isChange(cmd)) this.lastChange = { cmd, insert: '' }
	}

	// -- registers --

	setRegister(text: string, linewise: boolean): void {
		this.register = { text, linewise }
	}

	// -- motions --

	/** Where `motion` goes from the cursor, or null when it cannot. `op` is the operator it serves. */
	motion(m: Motion, count: number | null, op: Op | null): Moved | null {
		const doc = this.doc
		const ci = this.ci
		const n = doc.n
		const times = count ?? 1
		const ls = doc.lineStart(ci)
		const le = doc.lineEnd(ci)
		const forOp = op !== null
		switch (m.key) {
			case 'h': {
				const to = Math.max(ls, ci - times)
				return to === ci ? null : { to, kind: 'excl' }
			}
			case 'l': {
				const limit = forOp ? le : Math.max(ls, le - 1)
				const to = Math.min(limit, ci + times)
				return to === ci ? null : { to, kind: 'excl' }
			}
			case ' ': {
				let i = ci
				for (let k = 0; k < times; k += 1) {
					if (i >= n - 1) break
					i += 1
					if (doc.chars[i] === '\n' && !doc.isEmptyLine(i) && i < n - 1) i += 1
				}
				return i === ci ? null : { to: i, kind: 'excl' }
			}
			case 'BS': {
				let i = ci
				for (let k = 0; k < times; k += 1) {
					if (i <= 0) break
					i -= 1
					if (doc.chars[i] === '\n' && !doc.isEmptyLine(i) && i > 0) i -= 1
				}
				return i === ci ? null : { to: i, kind: 'excl' }
			}
			case 'j':
			case 'gj': {
				let cur = ls
				let moved = 0
				while (moved < times) {
					const end = doc.lineEnd(cur)
					if (end >= n) break
					cur = end + 1
					moved += 1
				}
				if (moved === 0) return null
				return this.onLine(cur, ci, ls)
			}
			case 'k':
			case 'gk': {
				let cur = ls
				let moved = 0
				while (moved < times && cur > 0) {
					cur = doc.lineStart(cur - 1)
					moved += 1
				}
				if (moved === 0) return null
				return this.onLine(cur, ci, ls)
			}
			case 'G': {
				const to = count === null ? doc.startOfLine(doc.lineCount - 1) : doc.startOfLine(count - 1)
				return { to, kind: 'line' }
			}
			case 'gg':
				return { to: count === null ? 0 : doc.startOfLine(count - 1), kind: 'line' }
			case '0':
				return { to: ls, kind: 'excl' }
			case '^':
				return { to: doc.firstNonBlank(ci), kind: 'excl' }
			case '$':
				// On an empty line there is nothing to take: an operator does nothing there.
				if (le === ls && op !== null) return null
				return { to: le > ls ? le - 1 : ls, kind: 'incl', wanted: Number.POSITIVE_INFINITY }
			case 'w':
			case 'W': {
				const big = m.key === 'W'
				if (
					op === 'c' &&
					ci < n &&
					charClass(doc.chars[ci] as string, big) !== 'space' &&
					doc.chars[ci] !== '\n'
				) {
					let to = currentWordEnd(doc, ci, big)
					for (let k = 1; k < times; k += 1) to = wordEnd(doc, to, big)
					return { to, kind: 'incl' }
				}
				let at = ci
				for (let k = 0; k < times; k += 1) {
					const before = at
					at = nextWordStart(doc, at, big)
					// The last word of a line, moved over by an operator, stops at the line's end.
					if (forOp && k === times - 1 && doc.lineStart(at) > doc.lineStart(before)) {
						at = doc.lineEnd(before)
					}
				}
				return at === ci && !forOp ? null : { to: forOp ? at : Math.min(at, n), kind: 'excl' }
			}
			case 'b':
			case 'B': {
				let at = ci
				for (let k = 0; k < times; k += 1) at = prevWordStart(doc, at, m.key === 'B')
				return at === ci ? null : { to: at, kind: 'excl' }
			}
			case 'e':
			case 'E': {
				let at = ci
				for (let k = 0; k < times; k += 1) at = wordEnd(doc, at, m.key === 'E')
				return at === ci && !forOp ? null : { to: at, kind: 'incl' }
			}
			case 'f':
			case 'F':
			case 't':
			case 'T': {
				const to = findChar(doc, ci, m.key as FindKind, m.char as string, times, false)
				if (to === null) return null
				this.lastFind = { kind: m.key as FindKind, char: m.char as string }
				return { to, kind: m.key === 'f' || m.key === 't' ? 'incl' : 'excl' }
			}
			case ';':
			case ',': {
				const last = this.lastFind
				if (!last) return null
				const kind = (
					m.key === ';' ? last.kind : ({ f: 'F', F: 'f', t: 'T', T: 't' } as const)[last.kind]
				) as FindKind
				const to = findChar(doc, ci, kind, last.char, times, true)
				if (to === null) return null
				return { to, kind: kind === 'f' || kind === 't' ? 'incl' : 'excl' }
			}
			case '%': {
				if (times !== 1) return null
				const to = matchBracket(doc, ci)
				return to === null ? null : { to, kind: 'incl' }
			}
			default:
				return null
		}
	}

	/** The character a line motion lands on, keeping the wanted column. */
	private onLine(lineStart: number, ci: number, ls: number): Moved {
		const doc = this.doc
		const end = doc.lineEnd(lineStart)
		const length = end - lineStart
		const column = this.wanted ?? ci - ls
		const landed = length === 0 ? 0 : Math.min(column, length - 1)
		return { to: lineStart + landed, kind: 'line', wanted: column }
	}

	/** A motion typed on its own in NORMAL or VISUAL. */
	moveBy(m: Motion, count: number | null): void {
		const moved = this.motion(m, count, null)
		if (!moved) {
			if (this.mode === 'NORMAL' && this.pending.length === 0) {
				if (m.key === 'k') this.effects.push('history-up')
				else if (m.key === 'j') this.effects.push('history-down')
			}
			return
		}
		this.wanted = moved.wanted ?? null
		this.at(moved.to)
	}

	// -- operators --

	private lineBounds(l1: number, l2: number): readonly [number, number] {
		const doc = this.doc
		const start = doc.startOfLine(l1)
		return [start, doc.lineEnd(doc.startOfLine(l2))]
	}

	/** An operator over whole lines `l1..l2`. */
	opLines(op: Op, l1: number, l2: number, times = 1): void {
		const doc = this.doc
		const [s, e] = this.lineBounds(l1, l2)
		const body = doc.slice(s, e)
		if (op === 'y') {
			this.setRegister(`${body}\n`, true)
			const here = doc.lineOf(this.ci)
			if (here > l1) this.at(Math.min(s + (this.ci - doc.lineStart(this.ci)), e))
			return
		}
		if (op === '<' || op === '>') {
			this.indentLines(op, l1, l2, times)
			return
		}
		this.setRegister(`${body}\n`, true)
		if (op === 'c') {
			this.splice(s, e, '')
			this.at(s)
			this.enterInsert(1, this.currentCmd)
			return
		}
		const hasNext = e < doc.n
		if (hasNext) this.splice(s, e + 1, '')
		else if (s > 0) this.splice(s - 1, e, '')
		else this.splice(0, doc.n, '')
		const target = hasNext ? l1 : Math.max(0, l1 - 1)
		const fresh = this.doc
		this.at(fresh.firstNonBlank(fresh.startOfLine(target)))
	}

	private indentLines(op: '<' | '>', l1: number, l2: number, times: number): void {
		let text = this.text
		const lines = text.split('\n')
		for (let line = l1; line <= Math.min(l2, lines.length - 1); line += 1) {
			const current = lines[line] as string
			if (op === '>') {
				if (current.length > 0) lines[line] = '  '.repeat(times) + current
			} else {
				let rest = current
				for (let k = 0; k < times; k += 1) {
					if (rest.startsWith('\t')) rest = rest.slice(1)
					else if (rest.startsWith('  ')) rest = rest.slice(2)
					else if (rest.startsWith(' ')) rest = rest.slice(1)
				}
				lines[line] = rest
			}
		}
		text = lines.join('\n')
		this.text = text
		this.wanted = null
		const fresh = this.doc
		this.at(fresh.firstNonBlank(fresh.startOfLine(l1)))
	}

	/** Characters `[a, b)` grown to take every marker they cut into whole. */
	private wholeChips(a: number, b: number): [number, number] {
		if (this.chips.length === 0) return [a, b]
		const doc = this.doc
		let from = doc.off(a)
		let to = doc.off(b)
		for (const chip of this.chips) {
			if (from > chip.start && from < chip.end) from = chip.start
			if (to > chip.start && to < chip.end) to = chip.end
		}
		return [doc.idx(from), doc.idx(to)]
	}

	/** An operator over characters `[a, b)`. */
	opChars(op: Op, from: number, to: number): void {
		const doc = this.doc
		if (op === '<' || op === '>') {
			this.indentLines(op, doc.lineOf(from), doc.lineOf(Math.max(from, to - 1)), 1)
			return
		}
		const [a, b] = this.wholeChips(from, to)
		const removed = doc.slice(a, b)
		if (op === 'y') {
			this.setRegister(removed, false)
			this.at(a)
			return
		}
		if (removed.length > 0) this.setRegister(removed, false)
		this.splice(a, b, '')
		this.at(a)
		if (op === 'c') this.enterInsert(1, this.currentCmd)
	}

	/** The command being run, so an insert it starts is remembered for `.`. */
	currentCmd: Cmd | null = null

	runOperator(cmd: Extract<Cmd, { t: 'op' }>): void {
		const doc = this.doc
		const ci = this.ci
		const explicit = cmd.count !== null || cmd.count2 !== null
		const count = cap((cmd.count ?? 1) * (cmd.count2 ?? 1))
		const here = doc.lineOf(ci)
		const target = cmd.target
		if (target.t === 'double') {
			this.opLines(cmd.op, here, Math.min(doc.lineCount - 1, here + count - 1))
			return
		}
		if (target.t === 'obj') {
			const span = textObject(doc, ci, target.obj, target.inner, count)
			if (!span) return
			this.opChars(cmd.op, span[0], span[1])
			return
		}
		const moved = this.motion(target.motion, explicit ? count : null, cmd.op)
		if (!moved) return
		if (moved.kind === 'line') {
			const there = doc.lineOf(moved.to)
			this.opLines(cmd.op, Math.min(here, there), Math.max(here, there))
			return
		}
		let a: number
		let b: number
		if (moved.to >= ci) {
			a = ci
			b = moved.to + (moved.kind === 'incl' ? 1 : 0)
			// An exclusive motion that ends at the start of a later line stops before the break.
			if (moved.kind === 'excl' && b > a && b <= doc.n && doc.chars[b - 1] === '\n') {
				b -= 1
			}
		} else {
			a = moved.to
			b = ci
		}
		this.opChars(cmd.op, a, Math.min(b, doc.n))
	}

	// -- simple commands --

	paste(after: boolean, times: number): void {
		const reg = this.register
		if (reg.text.length === 0) return
		const doc = this.doc
		const ci = this.ci
		if (reg.linewise) {
			const body = reg.text.endsWith('\n') ? reg.text.slice(0, -1) : reg.text
			const block = Array.from({ length: times }, () => body).join('\n')
			if (after) {
				const le = doc.lineEnd(ci)
				this.splice(le, le, `\n${block}`)
				const fresh = this.doc
				this.at(fresh.firstNonBlank(le + 1))
			} else {
				const ls = doc.lineStart(ci)
				this.splice(ls, ls, `${block}\n`)
				const fresh = this.doc
				this.at(fresh.firstNonBlank(ls))
			}
			this.pasted = true
			return
		}
		const body = reg.text.repeat(times)
		const at = after && !doc.isEmptyLine(ci) && ci < doc.n ? ci + 1 : ci
		this.splice(at, at, body)
		this.pasted = true
		if (body.includes('\n')) this.at(at)
		else this.at(at + new Doc(body).n - 1)
	}

	join(count: number): void {
		let joins = Math.max(count, 2) - 1
		while (joins > 0) {
			const doc = this.doc
			const ci = this.ci
			const le = doc.lineEnd(ci)
			if (le >= doc.n) break
			const nextStart = le + 1
			const nextEnd = doc.lineEnd(nextStart)
			let k = nextStart
			while (k < nextEnd && charClass(doc.chars[k] as string, false) === 'space') k += 1
			const nextEmpty = k >= nextEnd
			const here = doc.chars[le - 1]
			const space =
				nextEmpty ||
				le === doc.lineStart(ci) ||
				here === ' ' ||
				here === '\t' ||
				doc.chars[k] === ')'
					? ''
					: ' '
			this.splice(le, k, space)
			this.at(le)
			joins -= 1
		}
	}

	private mapRange(a: number, b: number, fn: (ch: string) => string): void {
		const doc = this.doc
		let out = ''
		for (let i = a; i < b; i += 1) {
			const ch = doc.chars[i] as string
			out += ch === '\n' ? ch : fn(ch)
		}
		this.splice(a, b, out)
	}

	runSimple(cmd: Extract<Cmd, { t: 'simple' }>): void {
		const doc = this.doc
		const ci = this.ci
		const ls = doc.lineStart(ci)
		const le = doc.lineEnd(ci)
		const times = cmd.count ?? 1
		const here = doc.lineOf(ci)
		switch (cmd.key) {
			case 'i':
				this.enterInsert(times, cmd)
				return
			case 'a':
				this.at(ci < le ? ci + 1 : ci)
				this.enterInsert(times, cmd)
				return
			case 'I': {
				let at = ls
				while (at < le && charClass(doc.chars[at] as string, false) === 'space') at += 1
				this.at(at)
				this.enterInsert(times, cmd)
				return
			}
			case 'A':
				this.at(le)
				this.enterInsert(times, cmd)
				return
			case 'o':
				this.splice(le, le, '\n')
				this.at(le + 1)
				this.enterInsert(1, cmd)
				return
			case 'O':
				this.splice(ls, ls, '\n')
				this.at(ls)
				this.enterInsert(1, cmd)
				return
			case 'x':
			case 's': {
				const to = Math.min(le, ci + times)
				if (to > ci) {
					this.setRegister(doc.slice(ci, to), false)
					this.splice(ci, to, '')
					this.at(ci)
				}
				if (cmd.key === 's') this.enterInsert(1, cmd)
				return
			}
			case 'S':
				this.opLines('c', here, Math.min(doc.lineCount - 1, here + times - 1))
				return
			case 'D':
			case 'C': {
				if (le > ci) {
					this.setRegister(doc.slice(ci, le), false)
					this.splice(ci, le, '')
					this.at(ci)
				}
				if (cmd.key === 'C') this.enterInsert(1, cmd)
				return
			}
			case 'Y':
				this.opLines('y', here, Math.min(doc.lineCount - 1, here + times - 1))
				return
			case 'p':
				this.paste(true, times)
				return
			case 'P':
				this.paste(false, times)
				return
			case 'J':
				this.join(times)
				return
			case '~': {
				const to = Math.min(le, ci + times)
				if (to <= ci) return
				this.mapRange(ci, to, toggleCase)
				this.at(Math.min(to, Math.max(ls, le - 1)))
				return
			}
			default:
		}
	}

	runReplace(cmd: Extract<Cmd, { t: 'replace' }>): void {
		const doc = this.doc
		const ci = this.ci
		const times = cmd.count ?? 1
		if (ci + times > doc.lineEnd(ci)) return
		this.splice(ci, ci + times, cmd.char.repeat(times))
		this.replaced = true
		this.at(ci + times - 1)
	}

	// -- NORMAL --

	runNormal(cmd: Cmd): void {
		this.currentCmd = cmd
		const kept = this.lastChange
		const text = this.text
		const register = this.register
		if (isChange(cmd)) this.remember(cmd)
		this.runCommand(cmd)
		// A command that changed nothing is not a change: `.` keeps repeating the one before it.
		if (
			this.replay === null &&
			isChange(cmd) &&
			this.mode === 'NORMAL' &&
			this.text === text &&
			this.register === register &&
			!(cmd.t === 'replace' && this.replaced)
		) {
			this.lastChange = kept
		}
		this.replaced = false
	}

	/** Set by a replace that did change the line, which stays the thing `.` repeats. */
	private replaced = false

	private runCommand(cmd: Cmd): void {
		switch (cmd.t) {
			case 'motion':
				this.moveBy(cmd.motion, cmd.count)
				return
			case 'op':
				this.runOperator(cmd)
				return
			case 'replace':
				this.runReplace(cmd)
				return
			case 'simple':
				this.normalSimple(cmd)
				return
			default:
		}
	}

	private normalSimple(cmd: Extract<Cmd, { t: 'simple' }>): void {
		switch (cmd.key) {
			case 'u':
				this.effects.push('undo')
				return
			case '/':
				this.effects.push('history-search')
				this.mode = 'INSERT'
				this.insert = { baseText: this.text, baseCursor: this.cursor, repeat: 1, change: null }
				return
			case '.': {
				const last = this.lastChange
				if (!last) return
				const cmdToRun = cmd.count !== null ? withCount(last.cmd, cmd.count) : last.cmd
				const saved = this.replay
				this.replay = last.insert
				try {
					this.runNormal(cmdToRun)
				} finally {
					this.replay = saved
				}
				return
			}
			case 'v':
			case 'V':
				this.mode = cmd.key === 'v' ? 'VISUAL' : 'VISUAL LINE'
				this.anchor = this.cursor
				return
			default:
				this.runSimple(cmd)
		}
	}

	// -- VISUAL --

	private selection(): { readonly a: number; readonly b: number; readonly line: boolean } {
		const doc = this.doc
		if (doc.n === 0) return { a: 0, b: 0, line: this.mode === 'VISUAL LINE' }
		const a = Math.min(doc.idx(this.anchor), doc.n - 1)
		const c = Math.min(this.ci, doc.n - 1)
		const low = Math.min(a, c)
		const high = Math.max(a, c)
		if (this.mode === 'VISUAL LINE')
			return { a: doc.lineStart(low), b: doc.lineEnd(high), line: true }
		return { a: low, b: Math.min(high + 1, doc.n), line: false }
	}

	runVisual(cmd: Cmd): void {
		this.currentCmd = null
		if (cmd.t === 'motion') {
			this.moveBy(cmd.motion, cmd.count)
			return
		}
		if (cmd.t === 'vobj') {
			const doc = this.doc
			const span = textObject(doc, this.ci, cmd.obj, cmd.inner, cmd.count ?? 1)
			if (!span || span[1] <= span[0]) return
			this.mode = 'VISUAL'
			this.anchor = doc.off(span[0])
			this.at(span[1] - 1)
			return
		}
		const sel = this.selection()
		const doc = this.doc
		const times = cmd.t === 'simple' ? (cmd.count ?? 1) : 1
		const l1 = doc.lineOf(sel.a)
		const l2 = doc.lineOf(Math.max(sel.a, sel.b - (sel.line ? 0 : 1)))
		const finishNormal = (): void => {
			this.exitVisual()
		}
		if (cmd.t === 'replace') {
			this.mapRange(sel.a, sel.b, () => cmd.char)
			this.at(sel.a)
			finishNormal()
			return
		}
		if (cmd.t !== 'simple') return
		switch (cmd.key) {
			case 'o': {
				const old = this.anchor
				this.anchor = this.cursor
				this.cursor = old
				return
			}
			case 'v':
				if (this.mode === 'VISUAL') this.exitVisual()
				else this.mode = 'VISUAL'
				return
			case 'V':
				if (this.mode === 'VISUAL LINE') this.exitVisual()
				else this.mode = 'VISUAL LINE'
				return
			case 'd':
			case 'x':
			case 'c':
			case 's':
			case 'y': {
				finishNormal()
				const op: Op = cmd.key === 'x' ? 'd' : cmd.key === 's' ? 'c' : (cmd.key as Op)
				if (sel.line) this.opLines(op, l1, l2)
				else this.opChars(op, sel.a, sel.b)
				return
			}
			case 'Y':
				finishNormal()
				this.opLines('y', l1, l2)
				return
			case 'X':
			case 'D':
				finishNormal()
				this.opLines('d', l1, l2)
				return
			case 'C':
			case 'S':
			case 'R':
				finishNormal()
				this.opLines('c', l1, l2)
				return
			case '>':
			case '<':
				finishNormal()
				this.indentLines(cmd.key, l1, l2, times)
				return
			case 'J':
				finishNormal()
				this.at(doc.startOfLine(l1))
				this.join(Math.max(2, l2 - l1 + 1))
				return
			case '~':
				this.mapRange(sel.a, sel.b, toggleCase)
				this.at(sel.a)
				finishNormal()
				return
			case 'u':
				this.mapRange(sel.a, sel.b, (ch) => ch.toLowerCase())
				this.at(sel.a)
				finishNormal()
				return
			case 'U':
				this.mapRange(sel.a, sel.b, (ch) => ch.toUpperCase())
				this.at(sel.a)
				finishNormal()
				return
			case 'p':
			case 'P': {
				const reg = this.register
				if (reg.text.length === 0) {
					finishNormal()
					return
				}
				const removed = doc.slice(sel.a, sel.b)
				let body = reg.text
				if (reg.linewise) body = body.endsWith('\n') ? body.slice(0, -1) : body
				if (reg.linewise && !sel.line) body = `\n${body}\n`
				this.splice(sel.a, sel.b, body)
				this.setRegister(sel.line ? `${removed}\n` : removed, sel.line)
				this.at(sel.a)
				this.pasted = true
				finishNormal()
				return
			}
			default:
		}
	}

	// -- one key --

	feed(key: VimKey): void {
		if (this.mode === 'INSERT') {
			if (key.key === 'Escape' && !key.ctrl && !key.meta) this.exitInsert()
			else this.handled = false
			return
		}
		const visual = this.mode !== 'NORMAL'
		if (key.ctrl || key.meta) {
			if (visual) this.exitVisual()
			else this.handled = false
			return
		}
		if (key.key === 'Escape') {
			if (this.pending.length > 0) this.pending = []
			else if (visual) this.exitVisual()
			else this.handled = false
			return
		}
		let name = key.key
		switch (name) {
			case 'Enter':
				if (!visual) {
					// Nothing is sent, so nothing may stay half typed.
					this.pending = []
					this.handled = false
					return
				}
				name = 'j'
				break
			case 'Left':
				if (this.text.length === 0) {
					this.handled = false
					return
				}
				name = 'h'
				break
			case 'Right':
				name = 'l'
				break
			case 'Up':
				name = 'k'
				break
			case 'Down':
				name = 'j'
				break
			case 'Backspace':
				name = 'BS'
				break
			case 'Delete':
				name = visual ? 'd' : 'x'
				break
			default:
		}
		const keys = [...this.pending, name]
		const parsed = parseCommand(keys, visual)
		if (parsed.s === 'incomplete') {
			this.pending = keys
			return
		}
		this.pending = []
		if (parsed.s === 'invalid') return
		if (visual) this.runVisual(parsed.cmd)
		else this.runNormal(parsed.cmd)
	}
}

function toggleCase(ch: string): string {
	const lower = ch.toLowerCase()
	return ch === lower ? ch.toUpperCase() : lower
}

/** Feed one key. */
export function vimKey(
	state: VimState,
	text: string,
	cursor: number,
	key: VimKey,
	chips: readonly VimChip[] = [],
): VimResult {
	const machine = new Machine(state, text, cursor, chips)
	machine.feed(key)
	return machine.result()
}

/** Feed several keys in a row, as when a burst of typing arrives in one read. */
export function vimKeys(
	state: VimState,
	text: string,
	cursor: number,
	keys: readonly VimKey[],
	chips: readonly VimChip[] = [],
): VimResult {
	let result: VimResult = {
		handled: true,
		state,
		text,
		cursor,
		effects: [],
		pasted: false,
	}
	const effects: VimEffect[] = []
	let pasted = false
	for (const key of keys) {
		result = vimKey(result.state, result.text, result.cursor, key, chips)
		effects.push(...result.effects)
		pasted = pasted || result.pasted
		if (!result.handled) break
	}
	return { ...result, effects, pasted }
}
