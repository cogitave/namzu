import stringWidth from 'string-width'

import { terminalDisplayText } from './terminal-display.js'

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Backspace removes one user-perceived character from the original query. */
export function eraseLastChoiceGrapheme(source: string): string {
	let boundary = 0
	for (const { index } of graphemes.segment(source)) boundary = index
	return source.slice(0, boundary)
}

/** A menu field occupies one row, even if its source came from a file or tool. */
export function choiceDisplayText(source: string): string {
	return terminalDisplayText(source).replace(/[\n\t]/g, ' ')
}

export function choiceDisplayWidth(source: string): number {
	return stringWidth(choiceDisplayText(source))
}

/**
 * Break terminal text into lines that fit `columns` terminal cells.
 *
 * Written rather than left to the renderer because the renderer's own wrapping
 * keeps the space it broke at: a sentence wrapped by Ink put the space at the
 * START of the next line, so a notice inside a bordered box came out one column
 * indented on every continuation and did not line up with the sentence above
 * it. A wrapped line here never begins with the space it broke at.
 *
 * Explicit newlines are hard breaks — a notice built from an array of lines
 * means them, including the blank ones — and a line's own leading spaces are
 * kept, because an indented device code is indented on purpose. Only the space
 * the WRAP invented is dropped.
 */
export function wrapChoiceText(source: string, columns: number): readonly string[] {
	const width = Math.max(1, Math.floor(columns))
	const lines: string[] = []
	// Projected first, so an unsafe codepoint is measured as the literal this
	// screen will print rather than as the byte it came from.
	for (const paragraph of terminalDisplayText(source)
		.split('\n')
		.map((line) => line.replace(/\t/g, ' '))) {
		let line = ''
		for (const word of paragraph.split(' ')) {
			if (word === '') continue
			if (line === '') {
				line = word
				continue
			}
			if (choiceDisplayWidth(`${line} ${word}`) <= width) {
				line = `${line} ${word}`
				continue
			}
			lines.push(line)
			line = word
		}
		lines.push(line)
	}
	// A word wider than the box is broken rather than allowed to overflow it.
	return lines.flatMap((line) => breakOverlongWord(line, width))
}

/**
 * Split one word that cannot fit on a line of its own.
 *
 * Length-preserving in terminal cells: the pieces rejoin to the same text, so
 * an id or an address stays readable and copyable piece by piece rather than
 * being cut off.
 */
function breakOverlongWord(line: string, width: number): readonly string[] {
	if (choiceDisplayWidth(line) <= width) return [line]
	const pieces: string[] = []
	let piece = ''
	let used = 0
	for (const { segment } of graphemes.segment(line)) {
		const size = stringWidth(segment)
		if (used + size > width && piece !== '') {
			pieces.push(piece)
			piece = ''
			used = 0
		}
		piece += segment
		used += size
	}
	pieces.push(piece)
	return pieces
}

/**
 * Keep at most `max` lines, marking the last one when something was dropped.
 *
 * The marker is the same ellipsis a truncated row uses, so a cut is visible
 * wherever it happens rather than only on the widest screens.
 */
export function capChoiceLines(
	lines: readonly string[],
	max: number,
	columns: number,
): readonly string[] {
	if (lines.length <= max || max < 1) return lines
	const kept = lines.slice(0, max)
	const last = kept[max - 1] ?? ''
	return [...kept.slice(0, max - 1), truncateChoiceText(`${last} …`, columns)]
}

/** Truncate by terminal cells without slicing a combining sequence or an emoji. */
export function truncateChoiceText(source: string, columns: number): string {
	const text = choiceDisplayText(source)
	const width = Math.max(0, Math.floor(columns))
	if (width === 0) return ''
	if (stringWidth(text) <= width) return text
	let result = ''
	let used = 0
	for (const { segment } of graphemes.segment(text)) {
		const size = stringWidth(segment)
		if (used + size > width - 1) break
		result += segment
		used += size
	}
	return `${result}…`
}
