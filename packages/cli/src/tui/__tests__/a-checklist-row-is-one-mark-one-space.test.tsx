/**
 * One checklist renderer, whose marks are text and one cell wide.
 *
 * The owner's Windows Terminal drew `☑` as a blue colour emoji and `☐` with
 * no space before its text (`☐Çalışma alanını incele`): both are emoji code
 * points, which emoji-capable fonts draw two cells wide over the space that
 * followed. These pin the marks by Unicode property rather than by eye, and
 * the rows by what a terminal emulator actually shows at 40 and 80 columns —
 * Turkish text, a subject longer than the row, completed struck through and
 * the current step in bold.
 */

import type { ReactElement } from 'react'
import stringWidth from 'string-width'
import { describe, expect, it } from 'vitest'

import {
	CHECKLIST_MARK,
	Checklist,
	type ChecklistItem,
	ChecklistRow,
	checklistLine,
	checklistProgress,
} from '../Checklist.js'
import { MODE_MARK } from '../StatusBar.js'
import { renderToScreen } from './support/screen.js'

const TURKISH = 'Çalışma alanını incele ve değişiklikleri özetle'
const LONG =
	'Read every configuration file under the project root, note which keys each one overrides, and write the summary'

const PLAN: readonly ChecklistItem[] = [
	{ id: 'a', subject: TURKISH, status: 'completed' },
	{ id: 'b', subject: LONG, status: 'in_progress' },
	{ id: 'c', subject: 'Ğ ile başlayan dosyaları listele', status: 'pending' },
	{ id: 'd', subject: 'Yayın notunu yaz', status: 'failed' },
]

const MARKS = [...Object.values(CHECKLIST_MARK), ...MODE_MARK.moving, MODE_MARK.held]

describe('checklist marks', () => {
	it.each(MARKS)('%s is not an emoji code point and is one cell wide', (mark) => {
		expect(/\p{Extended_Pictographic}/u.test(mark)).toBe(false)
		expect(/\p{Emoji_Presentation}/u.test(mark)).toBe(false)
		expect(stringWidth(mark)).toBe(1)
		expect([...mark]).toHaveLength(1)
	})

	it('gives every status its own mark', () => {
		expect(new Set(Object.values(CHECKLIST_MARK)).size).toBe(4)
	})

	it('writes a row as mark, one space, the subject on one line', () => {
		expect(checklistLine({ id: 'x', subject: '  Çalışma\n alanını   incele ', status: 'pending' })).toBe(
			'□ Çalışma alanını incele',
		)
		for (const item of PLAN) {
			expect(checklistLine(item)).toMatch(/^[□■✓✗] \S/)
		}
	})

	it('counts completed of total, and failures apart', () => {
		expect(checklistProgress(PLAN)).toBe('Tasks · 1/4 done · 1 failed')
		expect(checklistProgress(PLAN.slice(0, 1))).toBe('Tasks · 1/1 done')
	})
})

describe('the checklist on a terminal', () => {
	it('keeps one space after each mark and hangs a wrapped subject under its first letter at 40 columns', async () => {
		const screen = await renderToScreen(<Checklist items={PLAN} />, { cols: 40, rows: 20 })
		try {
			const rows = screen.viewport().filter((row) => row.length > 0)
			for (const row of rows) expect(stringWidth(row)).toBeLessThanOrEqual(40)
			// Wrapped at a word, and the continuation starts two cells in,
			// under the text rather than under the mark.
			expect(rows[0]).toBe('✓ Çalışma alanını incele ve')
			expect(rows[1]).toBe('  değişiklikleri özetle')
			const current = rows.findIndex((row) => row.startsWith('■ '))
			expect(current).toBe(2)
			expect(rows[current]).toBe('■ Read every configuration file under')
			expect(rows[current + 1]).toBe('  the project root, note which keys each')
			// Ink keeps the space it broke at when a word ends exactly on the
			// edge; the continuation is still inside the gutter, never under it.
			expect(rows[current + 2]).toMatch(/^ {2,3}one overrides, and write the summary$/)
			expect(rows.join('\n')).toContain('□ Ğ ile başlayan dosyaları listele')
			expect(rows.join('\n')).toContain('✗ Yayın notunu yaz')
			expect(rows.join('\n'), 'no mark runs into its text').not.toMatch(/[□■✓✗]\S/)
		} finally {
			await screen.unmount()
		}
	})

	it('strikes through completed work and makes the current step bold', () => {
		// Read from the element tree: the test terminal has no colour, so the
		// renderer drops the attributes before they could be read back.
		const textProps = (item: ChecklistItem) => {
			const row = ChecklistRow({ item }) as ReactElement<{ children: ReactElement[] }>
			const body = row.props.children[1] as ReactElement<{ children: ReactElement }>
			return body.props.children.props as Record<string, unknown>
		}
		const [completed, current, pending] = PLAN.map(textProps)
		expect(completed).toMatchObject({ strikethrough: true, dimColor: true, bold: false })
		expect(current).toMatchObject({ strikethrough: false, bold: true })
		expect(pending).toMatchObject({ strikethrough: false, bold: false })
	})
})
