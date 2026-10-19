/**
 * A configured status line owns the quiet moments: its rows are drawn dim and
 * cut at the edge, and the footer's `shift+tab to cycle` reminder stays off.
 */

import { Box } from 'ink'
import { describe, expect, it } from 'vitest'

import { StatusBar } from '../StatusBar.js'
import { StatusLineRows } from '../status-line/StatusLineRows.js'
import { renderToScreen } from './support/screen.js'

describe('the custom status line rows', () => {
	it('draws each line on its own row, padded, and cuts one that is too wide', async () => {
		const screen = await renderToScreen(
			<Box flexDirection="column">
				<StatusLineRows text={`first line\n${'x'.repeat(60)}`} padding={2} />
			</Box>,
			{ cols: 30, rows: 6 },
		)
		try {
			const rows = screen.viewport()
			expect(rows[0]).toBe('   first line')
			expect(rows[1]?.startsWith('   xxx')).toBe(true)
			expect((rows[1] ?? '').length).toBeLessThanOrEqual(28)
		} finally {
			await screen.unmount()
		}
	})

	it('keeps the quiet cycle reminder unless a status line is configured', async () => {
		const reminder = async (restingHint: boolean) => {
			const screen = await renderToScreen(
				<Box flexDirection="column">
					<StatusBar provider="p" model="m" state="idle" canCycleMode restingHint={restingHint} />
				</Box>,
				{ cols: 80, rows: 4 },
			)
			try {
				return screen.viewport()[0] ?? ''
			} finally {
				await screen.unmount()
			}
		}
		expect(await reminder(true)).toContain('shift+tab to cycle')
		expect(await reminder(false)).not.toContain('shift+tab')
	})
})
