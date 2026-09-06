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
