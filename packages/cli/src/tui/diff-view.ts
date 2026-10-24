/**
 * A change to a file as terminal rows, drawn the way the reference terminal
 * draws it when its native highlighter is off.
 *
 * Each row is a line-number gutter, a `+`, `-` or space marker that the code
 * follows immediately, and the code. An added or removed row has a background
 * that runs to the full width; an unchanged row is dim in its gutter and plain
 * in its code. A removed row followed by an added row is compared word by word,
 * and when little of the pair differs the differing words get a stronger
 * background. Hunks are joined by a dim `...`. Long lines wrap inside the width
 * and the rows they continue on keep a blank gutter.
 *
 * Everything here is pure: rows in, rows out. `Transcript.tsx` paints them.
 */

import type { ToolDiffHunk } from '@namzu/sdk'
import { diffWords } from 'diff'
import stringWidth from 'string-width'

import type { DisplaySpan } from './markdown-wrap.js'
import { type DiffColors, diffColors, theme } from './theme.js'
import { hiddenLinesHint } from './truncation.js'

/** One run of a row that shares a style. */
export interface DiffSegment {
	readonly text: string
	readonly bg?: string
	readonly fg?: string
	readonly dim?: boolean
}

/** One terminal row, left to right. */
export type DiffViewRow = readonly DiffSegment[]

/** A created file shows this many rows before the fold. */
export const CREATE_PREVIEW_ROWS = 10
/** `/diff` (a whole working tree) shows this many rows before the fold. */
export const WORKSPACE_PREVIEW_ROWS = 40
/** A line longer than this is cut, with a note of how much. */
const MAX_LINE_CHARS = 2000
/** A pair of lines is drawn with word highlights only when this little of it differs. */
const WORD_DIFF_RATIO = 0.4
/** Tab stops, as the reference expands them. */
const TAB_STOP = 8

/** The rows `diffViewRows` draws between two hunks. */
export const HUNK_GAP = '...'

/**
 * What a transcript row remembers about the change it shows: enough to draw it
 * again at any width, and to say it in words.
 */
export interface DiffInfo {
	/** `hunks`: line-numbered rows with markers. `file`: the lines of a created file, as they are. */
	readonly mode: 'hunks' | 'file'
	readonly hunks: readonly ToolDiffHunk[]
	/** Rows shown before the fold; absent when the whole change shows. */
	readonly preview?: number
	/** The change was refused: drawn with the dimmed colours. */
	readonly dim?: true
	/** Lines added and removed over the whole change, even where `hunks` was cut short. */
	readonly added?: number
	readonly removed?: number
	/** The kernel carried only part of the change. */
	readonly truncated?: true
	/** The result row, with its numbers marked bold. */
	readonly summary?: readonly DisplaySpan[]
	/** A working tree: one heading and its hunks per file, in place of `hunks`. */
	readonly files?: readonly { readonly heading: string; readonly hunks: readonly ToolDiffHunk[] }[]
	/** Plain lines after the last file (a note that the patch was cut short). */
	readonly footer?: readonly string[]
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Expand tabs to the next stop. */
export function expandTabs(text: string): string {
	if (!text.includes('\t')) return text
	let out = ''
	let column = 0
	for (const { segment } of segmenter.segment(text)) {
		if (segment === '\t') {
			const fill = TAB_STOP - (column % TAB_STOP)
			out += ' '.repeat(fill)
			column += fill
		} else {
			out += segment
			column += stringWidth(segment)
		}
	}
	return out
}

/** The first `MAX_LINE_CHARS` of a line and how many characters were left off. */
function cutLine(code: string): { readonly code: string; readonly cut: number } {
	if (code.length <= MAX_LINE_CHARS) return { code, cut: 0 }
	let end = MAX_LINE_CHARS
	const last = code.charCodeAt(end - 1)
	if (last >= 0xd800 && last <= 0xdbff) end -= 1
	return { code: code.slice(0, end), cut: code.length - end }
}

function truncationNote(cut: number): string {
	return ` … [+${cut.toLocaleString('en-US')} chars]`
}

interface Run {
	readonly text: string
	readonly mark: boolean
}

/** Runs split into rows of at most `width` cells; always at least one row. */
function wrapRuns(runs: readonly Run[], width: number): Run[][] {
	const rows: Run[][] = [[]]
	let used = 0
	for (const run of runs) {
		let pending = ''
		const flush = () => {
			if (pending.length === 0) return
			rows[rows.length - 1]?.push({ text: pending, mark: run.mark })
			pending = ''
		}
		for (const { segment } of segmenter.segment(run.text)) {
			const w = stringWidth(segment)
			if (used + w > width && used > 0) {
				flush()
				rows.push([])
				used = 0
			}
			pending += segment
			used += w
		}
		flush()
	}
	return rows
}

type Kind = 'add' | 'remove' | 'same'

interface Entry {
	readonly kind: Kind
	readonly code: string
	readonly cut: number
	number: number
	pair?: Entry
}

function entriesOf(hunk: ToolDiffHunk): Entry[] {
	const entries: Entry[] = []
	for (const row of hunk.lines) {
		if (row.startsWith('\\')) continue
		const kind: Kind = row.startsWith('+') ? 'add' : row.startsWith('-') ? 'remove' : 'same'
		const { code, cut } = cutLine(expandTabs(row.slice(1)))
		entries.push({ kind, code, cut, number: 0 })
	}
	// A run of removed rows followed by a run of added rows is compared pairwise.
	for (let i = 0; i < entries.length; ) {
		if (entries[i]?.kind !== 'remove') {
			i++
			continue
		}
		let j = i
		while (entries[j]?.kind === 'remove') j++
		let k = j
		while (entries[k]?.kind === 'add') k++
		const pairs = Math.min(j - i, k - j)
		for (let n = 0; n < pairs; n++) {
			const gone = entries[i + n]
			const came = entries[j + n]
			if (gone && came) {
				gone.pair = came
				came.pair = gone
			}
		}
		i = k > j ? k : j
	}
	// Numbers: a removed run is numbered from the counter and the counter is
	// wound back, so the rows that replace it start at the same number.
	let counter = hunk.newStart
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]
		if (!entry) continue
		if (entry.kind === 'remove') {
			entry.number = counter
			let run = 0
			while (entries[i + 1]?.kind === 'remove') {
				counter++
				i++
				run++
				const next = entries[i]
				if (next) next.number = counter
			}
			counter -= run
		} else {
			entry.number = counter
			counter++
		}
	}
	return entries
}

/** The gutter's width for a hunk: the widest number plus one. */
function gutterWidth(entries: readonly Entry[]): number {
	const most = entries.reduce((max, entry) => Math.max(max, entry.number), 0)
	return String(most).length + 1
}

const MARKER: Record<Kind, string> = { add: '+', remove: '-', same: ' ' }

export interface DiffViewOptions {
	/** Cells each row fills. */
	readonly width: number
	/** Draw with the dimmed colours (a change that was refused). */
	readonly dim?: boolean
	readonly colors?: DiffColors
	/** The colour of the code on a coloured row. */
	readonly text?: string
}

/**
 * Hunks as terminal rows, each exactly `width` cells where it has a
 * background. A hunk with nothing in it draws nothing.
 */
export function diffViewRows(
	hunks: readonly ToolDiffHunk[],
	options: DiffViewOptions,
): DiffViewRow[] {
	const colors = options.colors ?? diffColors()
	const text = options.text ?? theme.text.primary
	const dim = options.dim === true
	const width = Math.max(1, Math.floor(options.width))
	const rows: DiffViewRow[] = []
	let first = true
	for (const hunk of hunks) {
		const entries = entriesOf(hunk)
		if (entries.length === 0) continue
		if (!first) rows.push([{ text: HUNK_GAP, dim: true }])
		first = false
		const m = gutterWidth(entries)
		for (const entry of entries) rows.push(...entryRows(entry, m, width, dim, colors, text))
	}
	return rows
}

function backgroundOf(kind: Kind, dim: boolean, colors: DiffColors): string | undefined {
	if (kind === 'add') return dim ? colors.addedDimmed : colors.added
	if (kind === 'remove') return dim ? colors.removedDimmed : colors.removed
	return undefined
}

function entryRows(
	entry: Entry,
	m: number,
	width: number,
	dim: boolean,
	colors: DiffColors,
	text: string,
): DiffViewRow[] {
	const bg = backgroundOf(entry.kind, dim, colors)
	const fg = bg === undefined ? undefined : text
	const marker = MARKER[entry.kind]
	const words = wordRuns(entry, dim)
	// The code is as wide as the row less the gutter, the marker and, outside
	// a word-compared pair, two cells the reference keeps in reserve.
	const room = Math.max(1, width - m - 1 - (words ? marker.length : 2))
	const pieces = wrapRuns(words ?? [{ text: entry.code, mark: false }], room)
	const note = entry.cut > 0 ? truncationNote(entry.cut) : ''
	let noteRow = -1
	if (note) {
		const last = pieces.at(-1) ?? []
		const used = last.reduce((sum, run) => sum + stringWidth(run.text), 0)
		if (used + stringWidth(note) > room) pieces.push([])
		noteRow = pieces.length - 1
	}
	const wordBg = entry.kind === 'add' ? colors.addedWord : colors.removedWord
	return pieces.map((runs, index) => {
		const number = index === 0 ? String(entry.number).padStart(m) : ' '.repeat(m)
		const gutter = `${number} `
		const code = runs.reduce((sum, run) => sum + stringWidth(run.text), 0)
		const tail = index === noteRow ? note : ''
		const pad = Math.max(0, width - (gutter.length + marker.length + code + stringWidth(tail)))
		const row: DiffSegment[] = [
			{
				text: `${gutter}${marker}`,
				...(bg ? { bg } : {}),
				...(fg ? { fg } : {}),
				...(dim || entry.kind === 'same' ? { dim: true } : {}),
			},
		]
		for (const run of runs) {
			row.push({
				text: run.text,
				...(run.mark ? { bg: wordBg } : bg ? { bg } : {}),
				...(fg ? { fg } : {}),
				...(dim ? { dim: true } : {}),
			})
		}
		if (tail) row.push({ text: tail, dim: true })
		if (bg && pad > 0) {
			row.push({ text: ' '.repeat(pad), bg, ...(fg ? { fg } : {}), ...(dim ? { dim: true } : {}) })
		}
		return row
	})
}

/**
 * The runs of one row of a word-compared pair, or undefined when the row is
 * not one, is dimmed, or differs too much from its partner to be worth it.
 */
function wordRuns(entry: Entry, dim: boolean): Run[] | undefined {
	const partner = entry.pair
	if (dim || !partner) return undefined
	const [old, now] =
		entry.kind === 'remove' ? [entry.code, partner.code] : [partner.code, entry.code]
	const parts = diffWords(old, now)
	const changed = parts
		.filter((part) => part.added || part.removed)
		.reduce((sum, part) => sum + part.value.length, 0)
	const total = old.length + now.length
	if (total === 0 || changed / total > WORD_DIFF_RATIO) return undefined
	const runs: Run[] = []
	for (const part of parts) {
		if (entry.kind === 'add') {
			if (part.removed) continue
			runs.push({ text: part.value, mark: part.added === true })
		} else {
			if (part.added) continue
			runs.push({ text: part.value, mark: part.removed === true })
		}
	}
	return runs
}

/** The text of a row, as it reads. */
export function viewRowText(row: DiffViewRow): string {
	return row.map((segment) => segment.text).join('')
}

/**
 * The rows of a created file: its lines as they are, wrapped to `width`, with
 * no gutter and no markers. `dim` is a file the person refused.
 */
export function fileViewRows(
	hunks: readonly ToolDiffHunk[],
	options: Pick<DiffViewOptions, 'width' | 'dim'>,
): DiffViewRow[] {
	const width = Math.max(1, Math.floor(options.width))
	const rows: DiffViewRow[] = []
	for (const hunk of hunks) {
		for (const line of hunk.lines) {
			if (line.startsWith('\\')) continue
			const { code, cut } = cutLine(expandTabs(line.slice(1)))
			const note = cut > 0 ? truncationNote(cut) : ''
			const pieces = wrapRuns([{ text: code, mark: false }], width)
			const last = pieces.at(-1) ?? []
			const used = last.reduce((sum, run) => sum + stringWidth(run.text), 0)
			if (note && used + stringWidth(note) > width) pieces.push([])
			pieces.forEach((runs, index) => {
				const segments: DiffSegment[] = runs.map((run) => ({
					text: run.text,
					...(options.dim ? { dim: true } : {}),
				}))
				if (note && index === pieces.length - 1) segments.push({ text: note, dim: true })
				rows.push(segments)
			})
		}
	}
	return rows
}

function allRows(info: DiffInfo, width: number): DiffViewRow[] {
	const dim = info.dim ? ({ dim: true } as const) : {}
	if (info.files) {
		const rows: DiffViewRow[] = []
		for (const file of info.files) {
			if (rows.length > 0) rows.push([{ text: '' }])
			rows.push([{ text: file.heading }])
			rows.push(...diffViewRows(file.hunks, { width, ...dim }))
		}
		for (const line of info.footer ?? []) rows.push([{ text: line, dim: true }])
		return rows
	}
	return info.mode === 'file'
		? fileViewRows(info.hunks, { width, ...dim })
		: diffViewRows(info.hunks, { width, ...dim })
}

/** What the transcript paints for a change: its rows, then the fold notice if any rows are left out. */
export function diffViewBody(
	info: DiffInfo,
	options: { readonly width: number; readonly expanded: boolean; readonly canExpand: boolean },
): DiffViewRow[] {
	const all = allRows(info, options.width)
	const limit = options.expanded || info.preview === undefined ? all.length : info.preview
	const shown = all.slice(0, limit)
	// The kernel may have carried only the first part of a long file: the
	// lines it left out are still lines the person could open.
	const carried = info.hunks.reduce(
		(count, hunk) => count + hunk.lines.filter((line) => line.startsWith('+')).length,
		0,
	)
	const missing =
		info.mode === 'file' && info.truncated && info.added !== undefined
			? Math.max(0, info.added - carried)
			: 0
	const hidden = all.length - shown.length + (shown.length === all.length ? 0 : missing)
	if (hidden > 0) {
		shown.push([
			{
				text: hiddenLinesHint(hidden, { canExpand: options.canExpand }),
				dim: true,
			},
		])
	} else if (info.truncated) {
		shown.push([{ text: '… more changes are not shown', dim: true }])
	}
	return shown
}

/**
 * The same rows as plain text, one per logical row and not wrapped: what a
 * copy, an export or the output viewer holds, and what height is estimated from.
 */
export function plainDiffRows(
	info: Pick<DiffInfo, 'mode' | 'hunks' | 'files' | 'footer'>,
): string[] {
	const rows: string[] = []
	if (info.files) {
		for (const file of info.files) {
			if (rows.length > 0) rows.push('')
			rows.push(file.heading, ...plainDiffRows({ mode: 'hunks', hunks: file.hunks }))
		}
		rows.push(...(info.footer ?? []))
		return rows
	}
	if (info.mode === 'file') {
		for (const hunk of info.hunks) {
			for (const line of hunk.lines) {
				if (!line.startsWith('\\')) rows.push(expandTabs(line.slice(1)))
			}
		}
		return rows
	}
	let first = true
	for (const hunk of info.hunks) {
		const entries = entriesOf(hunk)
		if (entries.length === 0) continue
		if (!first) rows.push(HUNK_GAP)
		first = false
		const m = gutterWidth(entries)
		for (const entry of entries) {
			rows.push(`${String(entry.number).padStart(m)} ${MARKER[entry.kind]}${entry.code}`)
		}
	}
	return rows
}

function plural(count: number, one: string, many: string): string {
	return count === 1 ? one : many
}

function bold(count: number): DisplaySpan {
	return { text: count.toLocaleString('en-US'), bold: true }
}

/** `Added 2 lines, removed 1 line`; `Removed` leads when nothing was added. */
export function editSummary(added: number, removed: number): readonly DisplaySpan[] {
	const spans: DisplaySpan[] = []
	if (added > 0) {
		spans.push({ text: 'Added ' }, bold(added), { text: ` ${plural(added, 'line', 'lines')}` })
	}
	if (added > 0 && removed > 0) spans.push({ text: ', ' })
	if (removed > 0) {
		spans.push({ text: added === 0 ? 'Removed ' : 'removed ' }, bold(removed), {
			text: ` ${plural(removed, 'line', 'lines')}`,
		})
	}
	return spans
}

/** `Wrote 3 lines to src/a.ts`, the numbers and the path in bold. */
export function writeSummary(lines: number, path: string): readonly DisplaySpan[] {
	return [
		{ text: 'Wrote ' },
		bold(lines),
		{ text: ` ${plural(lines, 'line', 'lines')} to ` },
		{ text: path, bold: true },
	]
}

/** The spans as one string. */
export function spansText(spans: readonly DisplaySpan[]): string {
	return spans.map((span) => span.text).join('')
}
