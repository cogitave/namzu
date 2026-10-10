/**
 * The slash menu's key line is one row and the menu is no taller than the
 * terminal, at the widths a person's terminal and split pane really have.
 *
 * Found in a real PTY: at 60 columns "tab complete" wrapped onto a second row
 * (the width it fitted to ignored the frame), at 40 it was cut to a bare "tab",
 * and at 40 columns by 24 rows and 50 by 30 the menu was taller than the screen
 * because descriptions wrapped to four and five lines under a budget of two.
 */

import { expect, it } from 'vitest'

import { Composer, clampDescription } from '../Composer.js'
import { ComposerFrame } from '../ComposerFrame.js'
import type { SlashCommand } from '../slashCommands.js'
import { renderToScreen } from './support/screen.js'

const LONG =
	'Inspect delegated agents; /agents available lists configured agents, /agents batches lists past and running batches of delegated work.'

const commands: SlashCommand[] = Array.from({ length: 20 }, (_, at) => ({
	name: `command${at}`,
	description: LONG,
	action: () => ({ kind: 'none' }),
}))

it.each([
	[40, 24],
	[50, 30],
	[60, 24],
	[80, 24],
	[116, 30],
	[160, 50],
])(
	'is one key row, whole hints, and fits the screen at %i columns by %i rows',
	async (cols, rows) => {
		const screen = await renderToScreen(
			<ComposerFrame focus columns={cols}>
				<Composer history={[]} onSubmit={() => {}} builtins={commands} />
			</ComposerFrame>,
			{
				cols,
				rows,
			},
		)
		try {
			screen.press('/')
			await screen.waitForRender()
			const view = screen.viewport()
			const text = view.join('\n')
			const keyAt = view.findIndex((line) => /\d+\/20 · /.test(line))
			expect(keyAt, text).toBeGreaterThan(-1)
			// The row after the key row is the bottom border: the line did not wrap.
			expect(view[keyAt + 1], text).toMatch(/^\s*└─*┘/)
			const key = (view[keyAt] ?? '').replace(/[│\s]+$/, '').replace(/^\s*│\s*/, '')
			for (const hint of key.split(' · ').slice(1)) {
				expect(hint).toMatch(/^(↑↓ select|PgUp\/PgDn( jump)?|enter run|tab complete)$/)
			}
			expect(key).toContain('↑↓ select')
			expect(key).toContain('enter run')
			// Nothing was pushed off the top: the message frame is still on screen.
			expect(text).toContain('MESSAGE')
		} finally {
			await screen.unmount()
		}
	},
)

it('keeps a description to two lines and says it goes on', () => {
	const lines = clampDescription(LONG, 20)
	expect(lines).toHaveLength(2)
	expect(lines[1]).toMatch(/…$/)
	expect(clampDescription('Short one.', 20)).toEqual(['Short one.'])
})
