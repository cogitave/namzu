/**
 * Shift+Tab is the composer's key. Where no composer is on screen (a picker,
 * the trust prompt, a startup that stopped) the footer must not advertise it,
 * but it still names the folder and, if one is on, the permission mode.
 */

import { Box } from 'ink'
import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'

import { StatusBar } from '../StatusBar.js'
import { renderToScreen } from './support/screen.js'

const CWD = '/home/dev/work/namzu'

function footer(element: ReactElement) {
	return <Box flexDirection="column">{element}</Box>
}

describe('the footer with no composer on screen', () => {
	it.each([40, 80, 116])('names no cycle key at %i columns, and keeps the folder', async (cols) => {
		const screen = await renderToScreen(
			footer(
				<StatusBar
					cwd={CWD}
					provider="a-provider"
					model="gpt-5.6-terra"
					state="idle"
					canCycleMode
					composerMounted={false}
				/>,
			),
			{ cols, rows: 6 },
		)
		try {
			const row = screen.viewport()[0] ?? ''
			expect(row).not.toContain('shift+tab')
			expect(row).toContain('namzu')
			// No separator is left in front of the folder.
			expect(row.trimStart().startsWith('·')).toBe(false)
		} finally {
			await screen.unmount()
		}
	})

	it('still says which mode is on, without the cycle reminder', async () => {
		const screen = await renderToScreen(
			footer(
				<StatusBar
					cwd={CWD}
					provider="a-provider"
					model="gpt-5.6-terra"
					state="idle"
					permissionMode="auto"
					canCycleMode
					composerMounted={false}
				/>,
			),
			{ cols: 80, rows: 6 },
		)
		try {
			const row = screen.viewport()[0] ?? ''
			expect(row).toContain('⏵⏵ Auto-approve tools')
			expect(row).not.toContain('shift+tab')
		} finally {
			await screen.unmount()
		}
	})

	it('keeps the reminder where a composer is mounted', async () => {
		const screen = await renderToScreen(
			footer(<StatusBar cwd={CWD} provider="a-provider" model="gpt-5.6-terra" state="idle" />),
			{ cols: 80, rows: 6 },
		)
		try {
			expect(screen.viewport()[0] ?? '').toContain('shift+tab to cycle')
		} finally {
			await screen.unmount()
		}
	})
})
