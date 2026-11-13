/**
 * What `namzu watch` prints, and the loop that keeps it current.
 *
 * The rows are the ones a reopened conversation gets (`projectConversation`
 * over the folded messages and the journal's trail), so a change to how a
 * step is drawn reaches the watcher too. They are printed as scrollback: a
 * row is written once and never redrawn. A terminal also gets one status line
 * at the bottom, redrawn in place; plain mode has no terminal control at all
 * and writes a line when the state changes instead.
 *
 * Every string that came from the session passes through
 * `terminalDisplayText`, so a session cannot move the cursor or recolour the
 * screen of the person watching it.
 */

import stringWidth from 'string-width'

import { projectConversation } from '../../tui/App.js'
import { glyphForRole } from '../../tui/Transcript.js'
import { colourLines, languagesIn, whenGrammarsSettle } from '../../tui/code-highlight.js'
import { closesFence, openingFence, stripFenceIndent } from '../../tui/markdown-fence.js'
import { trailFromRecords } from '../../tui/restored-rows.js'
import { terminalDisplayText } from '../../tui/terminal-display.js'
import { foregroundEscape, rowTints, theme, tintEscape } from '../../tui/theme.js'
import { EXPAND_HINT } from '../../tui/truncation.js'
import type { TranscriptMessage } from '../../tui/types.js'
import type { SessionFollower, WatchSnapshot, WatchState, WatchStatus } from './session-watch.js'

/** Said once at the start, because it is the thing a watcher cannot do. */
export const WATCH_READ_ONLY_NOTE =
	'Read-only: this view never sends a message, approves or answers anything.'
/** What the header says instead when the watcher has its one key: it still reads only, and says what the key does. */
export const WATCH_SAY_NOTE =
	'This view never approves or answers anything and never writes the session. Press m to say something to the session as yourself; it cannot approve anything.'
export const WATCH_SETTLED_NOTE =
	'Steps appear here as they settle; text a step is still writing appears when that step ends.'

/** The rows of a snapshot, drawn as a reopened conversation draws them. */
export function rowsOf(snapshot: WatchSnapshot, cwd: string): readonly TranscriptMessage[] {
	let n = 0
	return projectConversation(snapshot.messages, () => `watch-${n++}`, [], {
		trail: trailFromRecords(snapshot.records, {
			...(snapshot.liveTurnId !== undefined ? { liveTurnId: snapshot.liveTurnId } : {}),
		}),
		cwd,
	})
}

/**
 * The lines of `body` with the code in its fenced blocks in syntax colour: the same lines, each
 * code line written as runs between colour escapes. Nothing is added or taken out, and a block
 * whose language is not ready (or not known) is left as it is.
 */
export function colourFencedLines(lines: readonly string[]): string[] {
	const out = [...lines]
	for (let i = 0; i < lines.length; i++) {
		const opener = openingFence(lines[i] as string)
		if (!opener) continue
		let end = i + 1
		while (end < lines.length && !closesFence(lines[end] as string, opener)) end++
		const code = lines.slice(i + 1, end).map((line) => stripFenceIndent(line, opener.indent))
		const coloured = colourLines(opener.lang, code)
		coloured?.lines.forEach((runs, n) => {
			const original = lines[i + 1 + n] as string
			const indent = original.slice(0, original.length - (code[n] as string).length)
			out[i + 1 + n] =
				indent +
				runs
					.map((run) => {
						// Ordinary text keeps the terminal's own colour: watch never reads the theme setting.
						const on = run.kind ? foregroundEscape(theme.code[run.kind]) : ''
						return on === '' ? run.text : `${on}${run.text}\x1b[39m`
					})
					.join('')
		})
		i = end
	}
	return out
}

/** A row as plain text lines: gutter glyph, then the text hanging under it. */
export function rowLines(
	row: TranscriptMessage,
	options: { readonly colour?: boolean; readonly columns?: number } = {},
): string[] {
	const glyph = terminalDisplayText(row.glyph ?? glyphForRole(row.role))
	const body = terminalDisplayText(row.content).replace(/\n+$/, '')
	// A hint such as `(ctrl+o to expand)` follows the text after one space, as on the screen; any
	// other note after two.
	const metaText = row.meta ? terminalDisplayText(row.meta) : ''
	const meta = metaText === '' ? '' : `${metaText.startsWith('(') ? ' ' : '  '}${metaText}`
	const lines =
		options.colour && row.role === 'assistant'
			? colourFencedLines(body.split('\n'))
			: body.split('\n')
	const indent = glyph === '⎿' ? '  ' : ''
	const out = lines.map((line, index) =>
		index === 0 ? `${indent}${glyph} ${line}${meta}` : `${indent}  ${line}`,
	)
	// The terminal wraps these lines where it likes, by cell. A hint that would be cut across two
	// rows goes whole onto a row of its own instead (or, if it fits no row, is left off).
	// (The note stands after the first line of a row, as it always has.)
	if (options.columns !== undefined && metaText.startsWith('(') && out[0] !== undefined) {
		const before = `${indent}${glyph} ${lines[0] ?? ''}`
		out.splice(0, 1, ...fitHintByCell(before, ` ${metaText}`, options.columns, `${indent}  `))
	}
	return out
}

/**
 * `before` and then `tail` (a space and a hint), as lines for a terminal `columns` wide that
 * breaks a long line at the edge by cell: one line when the hint fits after the text on the last
 * row it takes, else the hint on a line of its own under `hang`, else its short form, else none.
 */
function fitHintByCell(
	before: string,
	tail: string,
	columns: number,
	hang: string,
): readonly string[] {
	const width = Math.max(10, columns)
	const used = stringWidth(before)
	const onLast = used === 0 ? 0 : ((used - 1) % width) + 1
	const hint = tail.trimStart()
	if (onLast + stringWidth(tail) <= width) return [`${before}${tail}`]
	if (stringWidth(`${hang}${hint}`) <= width) return [before, `${hang}${hint}`]
	const short = SHORT_HINTS.get(hint)
	if (short !== undefined && stringWidth(`${hang}${short}`) <= width)
		return [before, `${hang}${short}`]
	return [before]
}

const SHORT_HINTS: ReadonlyMap<string, string> = new Map([[EXPAND_HINT, '(ctrl+o)']])

/**
 * Printed lines for rows. A blank line separates rows, except before a `⎿`
 * result line, which belongs to the row above it. A grouped row at the end may
 * still grow while the turn runs, so it is held back until something follows
 * it or the turn settles.
 */
export function transcriptLines(
	rows: readonly TranscriptMessage[],
	options: {
		readonly holdOpenTail: boolean
		readonly colour?: boolean
		readonly columns?: number
	},
): string[] {
	return layoutLines(rows, options).lines
}

/** The printed lines, and which of them belong to the person's own message. */
function layoutLines(
	rows: readonly TranscriptMessage[],
	options: {
		readonly holdOpenTail: boolean
		readonly colour?: boolean
		readonly columns?: number
	},
): { lines: string[]; mine: boolean[] } {
	// A call still in flight is held back with everything after it, so a later
	// call that settled first does not print ahead of it and reorder the rows.
	const inFlight = options.holdOpenTail ? rows.findIndex((row) => row.pending === true) : -1
	const settled = inFlight >= 0 ? rows.slice(0, inFlight) : rows
	const shown =
		inFlight < 0 &&
		options.holdOpenTail &&
		rows.length > 0 &&
		isOpenRow(rows[rows.length - 1] as TranscriptMessage)
			? rows.slice(0, -1)
			: settled
	const lines: string[] = []
	const mine: boolean[] = []
	shown.forEach((row, index) => {
		if (index > 0 && row.glyph !== '⎿') {
			lines.push('')
			mine.push(false)
		}
		const own = row.role === 'user' && (row.glyph ?? glyphForRole(row.role)) === '›'
		for (const line of rowLines(row, {
			...(options.colour ? { colour: true } : {}),
			...(options.columns !== undefined ? { columns: options.columns } : {}),
		})) {
			lines.push(line)
			mine.push(own)
		}
	})
	return { lines, mine }
}

/** A line of the person's own message on its quiet tint, its pointer dimmer than the text. No trailing cells are written. */
function tintedLine(line: string, background: string): string {
	const pointer = line.startsWith('› ') ? '\x1b[2m›\x1b[22m' : null
	const rest = pointer ? line.slice(1) : line
	return `${background}${pointer ?? ''}${rest}\x1b[49m`
}

function isOpenRow(row: TranscriptMessage): boolean {
	return row.group !== undefined || row.pending === true
}

/** The status as one line. */
export function statusLine(
	status: WatchStatus,
	options: { readonly ended: 'stay' | 'exit'; readonly canSay?: boolean },
): string {
	const tail =
		status.state === 'finished' && options.ended === 'stay'
			? ' Still watching; a new turn will appear here. Ctrl+C leaves.'
			: ''
	// A watcher that can send says so in place of "read-only": it still never writes the log or answers
	// an approval, but it is no longer silent.
	const mode = options.canSay ? 'm to message it' : 'read-only'
	return `watching · ${mode} · ${status.state} · ${terminalDisplayText(status.sentence)}${tail}`
}

export interface PrinterOptions {
	readonly write: (text: string) => void
	/** No terminal control: no cursor movement, no line redrawing. */
	readonly plain: boolean
	readonly columns: number
	readonly ended: 'stay' | 'exit'
	/** The one-line input is available (a terminal, not plain mode). */
	readonly canSay?: boolean
}

/** Writes new rows once and keeps the status current. */
export class WatchPrinter {
	readonly #o: PrinterOptions
	#printed: string[] = []
	#lastState: WatchState | undefined
	#lastSentence: string | undefined
	#statusShown = false
	#statusText = ''
	#prompt: string | undefined
	#fitted = ''

	constructor(options: PrinterOptions) {
		this.#o = options
	}

	header(line: string): void {
		this.#clearStatus()
		this.#o.write(`${this.#o.plain ? '[watch] ' : ''}${terminalDisplayText(line)}\n`)
	}

	update(snapshot: WatchSnapshot, rows: readonly TranscriptMessage[]): void {
		const open = snapshot.status.state === 'running' || snapshot.status.state === 'waiting'
		const { lines, mine } = layoutLines(rows, {
			holdOpenTail: open,
			...(this.#o.plain ? {} : { colour: true, columns: this.#o.columns }),
		})
		const tints = this.#o.plain ? null : rowTints()
		const out: string[] = []
		const prefixHolds = this.#printed.every((line, index) => lines[index] === line)
		if (this.#printed.length > 0 && !prefixHolds) {
			out.push(
				this.#o.plain
					? '[watch] the session rewrote its history (compaction); showing it again from the top'
					: '── the session rewrote its history (compaction); showing it again from the top ──',
			)
			this.#printed = []
		}
		lines.slice(this.#printed.length).forEach((line, offset) => {
			const at = this.#printed.length + offset
			const background = tints && mine[at] ? tintEscape(tints.user) : ''
			out.push(background !== '' ? tintedLine(line, background) : line)
		})
		this.#printed = lines
		if (snapshot.brokenAt !== undefined && snapshot.changed) {
			out.push(
				`${this.#o.plain ? '[watch] ' : ''}the log's chain breaks at record ${snapshot.brokenAt}; what precedes it is shown`,
			)
		}
		const { status } = snapshot
		if (this.#o.plain) {
			if (out.length > 0) this.#o.write(`${out.join('\n')}\n`)
			if (status.state !== this.#lastState || status.sentence !== this.#lastSentence) {
				this.#o.write(`[watch] ${status.state}: ${terminalDisplayText(status.sentence)}\n`)
			}
		} else {
			const line = statusLine(status, {
				ended: this.#o.ended,
				...(this.#o.canSay ? { canSay: true } : {}),
			})
			const room = Math.max(10, this.#o.columns - 1)
			const fitted = line.length > room ? `${line.slice(0, room - 1)}…` : line
			this.#fitted = fitted
			// While the person is typing the bottom line is theirs; rows still scroll above it.
			const bottom = this.#prompt !== undefined ? this.#promptLine() : fitted
			// A quiet poll that changed nothing leaves the screen alone.
			if (out.length > 0 || !this.#statusShown || bottom !== this.#statusText) {
				this.#clearStatus()
				if (out.length > 0) this.#o.write(`${out.join('\n')}\n`)
				this.#o.write(bottom)
				this.#statusShown = true
				this.#statusText = bottom
			}
		}
		this.#lastState = status.state
		this.#lastSentence = status.sentence
	}

	/** Show the line being typed in place of the status line; `undefined` brings the status back. */
	prompt(text: string | undefined): void {
		if (this.#o.plain) return
		this.#prompt = text
		this.#clearStatus()
		const bottom = text !== undefined ? this.#promptLine() : this.#fitted
		this.#o.write(bottom)
		this.#statusShown = bottom.length > 0
		this.#statusText = bottom
	}

	/** One finished line of scrollback that is the watcher's own, such as what became of a message. */
	note(line: string): void {
		this.#clearStatus()
		this.#o.write(`${this.#o.plain ? '[watch] ' : '── '}${terminalDisplayText(line)}\n`)
		const bottom = this.#prompt !== undefined ? this.#promptLine() : this.#fitted
		this.#o.write(bottom)
		this.#statusShown = bottom.length > 0
		this.#statusText = bottom
	}

	#promptLine(): string {
		const label = 'message> '
		const room = Math.max(4, this.#o.columns - label.length - 2)
		const typed = terminalDisplayText(this.#prompt ?? '')
		const shown = typed.length > room ? `…${typed.slice(typed.length - room + 1)}` : typed
		return `${label}${shown}`
	}

	/** Leave the terminal with the status line finished, not half-erased. */
	close(note?: string): void {
		this.#clearStatus()
		if (note) this.#o.write(`${this.#o.plain ? '[watch] ' : ''}${terminalDisplayText(note)}\n`)
	}

	#clearStatus(): void {
		if (this.#statusShown) this.#o.write('\r\x1b[2K')
		this.#statusShown = false
	}
}

export type FollowEnd =
	| { readonly reason: 'ended'; readonly status: WatchStatus }
	| { readonly reason: 'aborted'; readonly status: WatchStatus | undefined }

export interface FollowOptions {
	readonly follower: SessionFollower
	readonly printer: WatchPrinter
	readonly cwd: string
	/** Return when the session ends (a turn settled, or its writer is gone). */
	readonly exitOnEnd: boolean
	readonly signal: AbortSignal
	/** Resolves when something may have changed: a file event, or the bounded fallback. */
	readonly wait: (signal: AbortSignal) => Promise<void>
}

export function isEnded(state: WatchState): boolean {
	return state === 'finished' || state === 'interrupted'
}

/** Poll, print, wait; until the signal aborts or, when asked, the session ends. */
export async function follow(options: FollowOptions): Promise<FollowEnd> {
	let last: WatchStatus | undefined
	let rows: readonly TranscriptMessage[] | undefined
	for (;;) {
		if (options.signal.aborted) return { reason: 'aborted', status: last }
		const snapshot = await options.follower.poll()
		last = snapshot.status
		// The projection costs a pass over the conversation; it is redone only
		// when records arrived, while the status is read every time.
		if (rows === undefined || snapshot.changed) rows = rowsOf(snapshot, options.cwd)
		// What is about to be printed is written once and never redrawn: read the grammars of its
		// code blocks first (a bounded wait, and none where nothing is coloured), so that it is
		// coloured on its first paint.
		await whenGrammarsSettle(languagesIn(rows.map((row) => row.content).join('\n')))
		options.printer.update(snapshot, rows)
		if (options.exitOnEnd && isEnded(snapshot.status.state)) {
			return { reason: 'ended', status: snapshot.status }
		}
		await options.wait(options.signal)
	}
}
