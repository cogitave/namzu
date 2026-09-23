/**
 * A row keeps its column when it settles.
 *
 * Ink prints `<Static>` output from the static node, so the one column of
 * padding App gives every row reached the live rows and never the settled
 * ones: a finished screen mixed rows at column 0 and column 1. The settled
 * rows now carry that padding themselves, at the width they had live.
 */

import { Box } from 'ink'
import { afterEach, expect, it } from 'vitest'

import { Transcript } from '../Transcript.js'
import type { TranscriptMessage } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

let mounted: Screen | undefined
afterEach(async () => {
	await mounted?.unmount()
	mounted = undefined
})

function row(id: string, content: string, glyph = '✓'): TranscriptMessage {
	return { id, role: 'tool', content, glyph }
}

it.each([40, 100])('draws settled and live rows from the same column at %i columns', async (cols) => {
	// Exactly as wide as a live row's text may be: the terminal, less App's
	// two padding columns, less the two-column glyph gutter.
	const full = 'ğ'.repeat(cols - 4)
	const messages = [
		row('a', 'İlk satır yerleşti'),
		row('b', full),
		row('c', 'Canlı satır', '∴'),
	]
	mounted = await renderToScreen(
		<Box flexDirection="column" paddingX={1}>
			<Transcript messages={messages} pending={null} state="idle" settled={2} resetKey={0} staticIndent={1} />
		</Box>,
		{ cols, rows: 12 },
	)
	const rows = mounted.viewport().filter((line) => line.trim().length > 0)
	expect(rows).toEqual([' ✓ İlk satır yerleşti', ` ✓ ${full}`, ' ∴ Canlı satır'])
})
