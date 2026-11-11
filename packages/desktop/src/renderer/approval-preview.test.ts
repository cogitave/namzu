import { expect, it } from 'vitest'
import { PREVIEW_ROWS, commandChip, diffPreview, textPreview } from './approval-preview.js'

const file = (changed?: [number, string]) =>
	Array.from({ length: 30 }, (_, i) =>
		changed && i + 1 === changed[0] ? changed[1] : `line ${i + 1}`,
	).join('\n')

it('starts one line before the first change and stops at four rows', () => {
	const preview = diffPreview(file(), file([12, 'LINE 12']))
	expect(preview.rows.map((row) => `${row.kind}:${row.line}:${row.text}`)).toEqual([
		'context:11:line 11',
		'remove:12:line 12',
		'add:12:LINE 12',
		'context:13:line 13',
	])
	expect(preview.rows).toHaveLength(PREVIEW_ROWS)
	// The link states the whole change: the changed pair and the context the diff draws around it.
	expect(preview.total).toBe(10)
})

it('shows a new file from its first line and counts every line', () => {
	const preview = diffPreview('', 'a\nb\nc\nd\ne\nf\n')
	expect(preview.rows.map((row) => row.text)).toEqual(['a', 'b', 'c', 'd'])
	expect(preview.rows.every((row) => row.kind === 'add')).toBe(true)
	expect(preview.total).toBe(6)
})

it('shows the first lines of a command and how many it has in all', () => {
	const preview = textPreview('a\nb\nc\nd\ne\nf\n')
	expect(preview.rows.map((row) => row.text)).toEqual(['a', 'b', 'c', 'd'])
	expect(preview.total).toBe(6)
	expect(textPreview('ls').total).toBe(1)
})

it('cuts a command to one line for the question and says when more follows', () => {
	expect(commandChip('pnpm test')).toBe('pnpm test')
	expect(commandChip('pnpm test\npnpm lint')).toBe('pnpm test …')
	const long = `echo ${'x'.repeat(100)}`
	expect(commandChip(long)).toHaveLength(72)
	expect(commandChip(long).endsWith('…')).toBe(true)
})
