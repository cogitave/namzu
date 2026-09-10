import stringWidth from 'string-width'
import { choiceDisplayText } from './terminal-choice-text.js'

function wrap(value: string, width: number): string[] {
	const lines: string[] = []
	let line = ''
	let cells = 0
	for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
		value,
	)) {
		const size = stringWidth(segment)
		if (cells + size > width && line) {
			lines.push(line)
			line = ''
			cells = 0
		}
		line += segment
		cells += size
	}
	lines.push(line)
	return lines
}

export function statusPanelLayout(source: readonly (readonly [string, string])[], columns = 80) {
	const width = Math.max(12, Math.min(96, columns - 2))
	const stacked = width < 54
	const contentWidth = width - 4
	const rows = source.map(([name, content], index) => {
		const label = name.startsWith('Spend (') ? 'Spend' : name
		const value = name.startsWith('Spend (')
			? `${content} · current/latest run, own calls`
			: content
		return {
			label,
			lines: wrap(choiceDisplayText(value), Math.max(1, contentWidth - (stacked ? 0 : 14))),
			gap: index > 0 && ['Permissions', 'Session', 'Tokens'].includes(label),
		}
	})
	const height =
		2 +
		2 +
		rows.reduce((sum, row) => sum + row.lines.length + (stacked ? 1 : 0) + (row.gap ? 1 : 0), 0) +
		1 +
		Math.ceil(49 / contentWidth)
	return { width, stacked, rows, height }
}
