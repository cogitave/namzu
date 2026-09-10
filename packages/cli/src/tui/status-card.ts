import stringWidth from 'string-width'
import { choiceDisplayText } from './terminal-choice-text.js'

/** A bounded terminal card that wraps values rather than losing full paths or ids. */
export function statusCard(rows: readonly (readonly [string, string])[], columns = 80): string {
	const width = Math.min(96, Math.max(12, columns - 6))
	const lines = rows.map(([label, value]) => `${label}: ${choiceDisplayText(value)}`)
	if (width < 30) return ['NAMZU / SESSION', ...lines].join('\n')
	const inside = width - 4
	const title = '┌─ NAMZU / SESSION '
	const result = [`${title}${'─'.repeat(width - stringWidth(title) - 1)}┐`]
	for (const line of lines) {
		let text = ''
		let cells = 0
		for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
			line,
		)) {
			const size = stringWidth(segment)
			if (cells + size > inside) {
				result.push(`│ ${text}${' '.repeat(inside - cells)} │`)
				text = '  '
				cells = 2
			}
			text += segment
			cells += size
		}
		result.push(`│ ${text}${' '.repeat(Math.max(0, inside - cells))} │`)
	}
	result.push(`└${'─'.repeat(width - 2)}┘`)
	return result.join('\n')
}
