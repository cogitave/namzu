import stringWidth from 'string-width'
import { describe, expect, it } from 'vitest'

import { MAX_ROW_LINES, type TableLine, layoutTable, tableHeight } from './markdown-table.js'
import { type MdBlock, parseMarkdown } from './markdownParser.js'

const SOURCE = `| Katman | Kullanılan yapı |
|---|---|
| **Agent core / loop** | **OpenClaw’ın kendi çekirdeği:** \`@openclaw/agent-core\` — agent loop, harness tipleri, mesajlar, compaction yardımcıları, prompt şablonları ve oturum saklama sözleşmeleri |
| Runtime facade | \`src/agents/runtime/\`, **\`@openclaw/runtime\`** |
| 中文 列 | 絵文字 🎉 [docs](https://docs.openclaw.ai/agent-runtime-architecture) |`

function table(source = SOURCE): Extract<MdBlock, { type: 'table' }> {
	const block = parseMarkdown(source)[0]
	if (block?.type !== 'table') throw new Error('not a table')
	return block
}

const text = (line: TableLine) => line.map((span) => span.text).join('')

/** The width a terminal draws: two cells for CJK and emoji, one for the box glyphs. */
const cells = (line: TableLine) => stringWidth(text(line))

describe('layoutTable', () => {
	it.each([160, 120])('draws a box sized to %i columns, every row exactly that wide', (columns) => {
		const width = columns - 4
		const layout = layoutTable(table(), width)
		expect(layout.mode).toBe('grid')
		const lines = layout.lines.map(text)
		expect(lines[0]).toMatch(/^┌─+┬─+┐$/)
		expect(lines.at(-1)).toMatch(/^└─+┴─+┘$/)
		expect(lines.filter((line) => /^├─+┼─+┤$/.test(line))).toHaveLength(3)
		// Sized to the terminal, not to a fixed column cap: the box spans the row.
		for (const line of layout.lines) expect(cells(line)).toBe(width)
	})

	it('keeps a short label column whole and wraps the long cell inside its column', () => {
		const lines = layoutTable(table(), 116).lines.map(text)
		expect(lines.some((line) => line.startsWith('│ Agent core / loop │'))).toBe(true)
		// The long cell continues on the next line of the same row, under the rule.
		const at = lines.findIndex((line) => line.startsWith('│ Agent core / loop │'))
		expect(lines[at + 1]).toMatch(/^│ +│ \S/)
		// Words are never cut mid-way when the column can hold them.
		expect(lines.join('\n')).toContain('compaction')
	})

	it('draws inline markdown in cells instead of showing its source', () => {
		const layout = layoutTable(table(), 156)
		const all = layout.lines.flat()
		expect(all.map((span) => span.text).join('')).not.toMatch(/\*\*|`/)
		expect(all.some((span) => span.code && span.text.includes('@openclaw/agent-core'))).toBe(true)
		expect(all.some((span) => span.code && span.bold && span.text === '@openclaw/runtime')).toBe(
			true,
		)
		expect(all.some((span) => span.bold && span.text.includes('Agent core'))).toBe(true)
		expect(all.some((span) => span.link && span.text === 'docs')).toBe(true)
	})

	it('centres the header and honours the separator row’s alignment', () => {
		const layout = layoutTable(table('| a | b |\n|:--|--:|\n| x | 1234567 |\n| yy | 1 |'), 40)
		const lines = layout.lines.map(text)
		expect(lines[1]).toBe('│ a  │    b    │')
		expect(lines[3]).toBe('│ x  │ 1234567 │')
		expect(lines[5]).toBe('│ yy │       1 │')
	})

	it('stacks the table as `Header: value` records at 80 columns when a row would wrap too far', () => {
		const long = Array.from({ length: 60 }, (_, i) => `sözcük${i}`).join(' ')
		const layout = layoutTable(
			table(`| Katman | Kullanılan yapı |\n|---|---|\n| Tool | ${long} |\n| TUI | kısa |`),
			76,
		)
		expect(layout.mode).toBe('stacked')
		const lines = layout.lines.map(text)
		expect(lines[0]).toBe('Katman: Tool')
		expect(lines[1]?.startsWith('Kullanılan yapı: sözcük0 ')).toBe(true)
		expect(lines).toContain('─'.repeat(40))
		expect(lines.at(-2)).toBe('Katman: TUI')
		expect(lines.at(-1)).toBe('Kullanılan yapı: kısa')
		for (const line of layout.lines) expect(cells(line)).toBeLessThanOrEqual(76)
		// The labels are bold, the rule is drawn as a border.
		expect(layout.lines[0]?.[0]?.bold).toBe(true)
		expect(layout.lines.find((line) => text(line).startsWith('─'))?.[0]?.border).toBe(true)
	})

	it('stacks at 40 columns, where the columns cannot hold their words', () => {
		const layout = layoutTable(table(), 36)
		expect(layout.mode).toBe('stacked')
		for (const line of layout.lines) expect(cells(line)).toBeLessThanOrEqual(36)
	})

	it('keeps the box straight around wide characters', () => {
		const layout = layoutTable(
			table('| 名前 | 値 |\n|---|---|\n| 絵文字 🎉 | 漢字 |\n| a | b |'),
			60,
		)
		expect(layout.mode).toBe('grid')
		const widths = new Set(layout.lines.map(cells))
		expect(widths.size).toBe(1)
	})

	it('never lets a grid row grow past the limit', () => {
		for (const width of [36, 76, 116, 156]) {
			const layout = layoutTable(table(), width)
			if (layout.mode !== 'grid') continue
			let run = 0
			for (const line of layout.lines.map(text)) {
				run = line.startsWith('│') ? run + 1 : 0
				expect(run).toBeLessThanOrEqual(MAX_ROW_LINES)
			}
		}
	})

	it('reports its drawn height for the live-region estimate', () => {
		expect(tableHeight(table(), 156)).toBe(layoutTable(table(), 156).lines.length)
	})
})
