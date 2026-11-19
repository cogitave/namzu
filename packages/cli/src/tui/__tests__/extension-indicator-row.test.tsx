/**
 * The terminal's always-visible mark of a running extension: one row each, the host's own sentence,
 * nothing at all when nothing runs, and cut at the edge instead of wrapping into the composer.
 */

import { Box } from 'ink'
import { describe, expect, it } from 'vitest'

import { ExtensionIndicatorRow } from '../ExtensionIndicatorRow.js'
import { renderToScreen } from './support/screen.js'

describe('the extension indicator row', () => {
	it('draws a dot and the sentence for each running extension', async () => {
		const screen = await renderToScreen(
			<Box flexDirection="column">
				<ExtensionIndicatorRow
					marks={[
						{ level: 'ok', label: 'Stub Recorder is counting which program is in front.' },
						{ level: 'warn', label: 'Other One is not responding. Recording may be incomplete.' },
					]}
				/>
			</Box>,
			{ cols: 80, rows: 4 },
		)
		try {
			const rows = screen.viewport()
			expect(rows[0]).toBe('● Stub Recorder is counting which program is in front.')
			expect(rows[1]).toBe('● Other One is not responding. Recording may be incomplete.')
		} finally {
			await screen.unmount()
		}
	})

	it('draws nothing when nothing runs, and cuts a long sentence at the edge', async () => {
		const empty = await renderToScreen(
			<Box flexDirection="column">
				<ExtensionIndicatorRow marks={[]} />
			</Box>,
			{ cols: 40, rows: 3 },
		)
		try {
			expect(empty.viewport().join('').trim()).toBe('')
		} finally {
			await empty.unmount()
		}
		const long = await renderToScreen(
			<Box flexDirection="column">
				<ExtensionIndicatorRow marks={[{ level: 'ok', label: `x${'y'.repeat(100)}` }]} />
			</Box>,
			{ cols: 30, rows: 3 },
		)
		try {
			expect((long.viewport()[0] ?? '').length).toBeLessThanOrEqual(30)
			expect(long.viewport()[1]?.trim()).toBe('')
		} finally {
			await long.unmount()
		}
	})
})
