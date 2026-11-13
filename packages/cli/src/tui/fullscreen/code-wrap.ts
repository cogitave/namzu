/**
 * A code line cut to rows, the way `<Text wrap="wrap">` cuts it.
 *
 * ## Why this is not asked of the renderer
 *
 * The cut has to be the one the normal transcript draws, and for a while it was
 * got by rendering the line with Ink's `renderToString`. That cannot be done
 * from where the rows are made: the rows of the window are built while the
 * window itself is being rendered, and a render started inside a render has
 * nothing to run it. React then leaves the inner tree's last update queued, the
 * helper frees the inner root's layout node, and the queued update runs on that
 * node afterwards, in the layout engine, which stops the program with
 * `table index is out of bounds`. It happened with any code line wider than
 * the window, which is every code block at 80 columns.
 *
 * So the same cut is done here, on plain text, with the same rules Ink's
 * wrapper has (word wrap, no trim, a word wider than a row broken between
 * graphemes, tabs to the next multiple of eight, the right edge of a row
 * trimmed as the renderer trims it). A test draws a large set of lines both
 * ways, outside a render, and requires the same rows, so the two cannot drift
 * apart unseen.
 *
 * Pure; unit-tested.
 */

import stringWidth from 'string-width'

const TAB_SIZE = 8
const segmenter = new Intl.Segmenter()
const graphemes = (text: string): string[] =>
	Array.from(segmenter.segment(text), ({ segment }) => segment)

function expandTabs(line: string): string {
	if (!line.includes('\t')) return line
	const parts = line.split('\t')
	let visible = 0
	let out = ''
	parts.forEach((part, i) => {
		out += part
		visible += stringWidth(part)
		if (i < parts.length - 1) {
			const spaces = TAB_SIZE - (visible % TAB_SIZE)
			out += ' '.repeat(spaces)
			visible += spaces
		}
	})
	return out
}

/** A word wider than a row, laid across the rows from where the last one ends. */
function wrapWord(rows: string[], word: string, columns: number): void {
	const chars = graphemes(word)
	let visible = stringWidth(rows[rows.length - 1] as string)
	chars.forEach((char, index) => {
		const width = stringWidth(char)
		if (visible + width <= columns) rows[rows.length - 1] += char
		else {
			rows.push(char)
			visible = 0
		}
		visible += width
		if (visible === columns && index < chars.length - 1) {
			rows.push('')
			visible = 0
		}
	})
	if (!visible && (rows[rows.length - 1] as string).length > 0 && rows.length > 1) {
		rows[rows.length - 2] += rows.pop() as string
	}
}

function wrapOne(line: string, columns: number): string[] {
	const text = expandTabs(line)
	const words = text.split(' ')
	const lengths = words.map((word) => stringWidth(word))
	const rows = ['']
	words.forEach((word, index) => {
		let rowLength = stringWidth(rows[rows.length - 1] as string)
		const length = lengths[index] as number
		if (index !== 0) {
			if (rowLength >= columns) {
				rows.push('')
				rowLength = 0
			}
			rows[rows.length - 1] += ' '
			rowLength += 1
		}
		if (length > columns) {
			const remaining = columns - rowLength
			const breaksHere = 1 + Math.floor((length - remaining - 1) / columns)
			const breaksNext = Math.floor((length - 1) / columns)
			if (breaksNext < breaksHere) rows.push('')
			wrapWord(rows, word, columns)
			return
		}
		if (rowLength + length > columns && rowLength > 0 && length > 0) rows.push('')
		rows[rows.length - 1] += word
	})
	return rows
}

/**
 * The rows of one code line at `width` cells. A line that fits is one row,
 * as it was written; a longer one is cut, and each row loses the blanks at its
 * right edge, which the renderer does not draw either.
 */
export function wrapCodeLine(line: string, width: number): string[] {
	const columns = Math.max(1, Math.floor(width))
	if (stringWidth(line) <= columns) return [line]
	return wrapOne(line.normalize(), columns).map((row) => row.trimEnd())
}
