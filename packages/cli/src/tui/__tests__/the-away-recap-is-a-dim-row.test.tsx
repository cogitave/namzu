/**
 * The away recap on screen: `※`, a bold `recap:` label, the text in italics,
 * all muted, wrapped under the label, with one blank row above it.
 */

import { createRequire } from 'node:module'

import { Box } from 'ink'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { Transcript } from '../Transcript.js'
import type { TranscriptMessage } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

// Ink's own copy of chalk decides whether styles are written; pin it so the
// bold label can be read back whatever colour depth the runner has.
const inkRequire = createRequire(createRequire(import.meta.url).resolve('ink'))
const chalk = (await import(inkRequire.resolve('chalk'))).default as { level: number }
const originalLevel = chalk.level
beforeAll(() => {
	chalk.level = 3
})
afterAll(() => {
	chalk.level = originalLevel
})

let mounted: Screen | undefined
afterEach(async () => {
	await mounted?.unmount()
	mounted = undefined
})

async function show(messages: readonly TranscriptMessage[], cols = 60) {
	mounted = await renderToScreen(
		<Box flexDirection="column" paddingX={1}>
			<Transcript
				messages={messages}
				pending={null}
				state="idle"
				settled={0}
				resetKey={0}
				staticIndent={1}
			/>
		</Box>,
		{ cols, rows: 30, scrollback: 100 },
	)
	return mounted
}

const RECAP: TranscriptMessage = {
	id: 'r',
	role: 'system',
	kind: 'recap',
	content: 'Adding retries to the upload client; tests pass. Next: wire the flag.',
}

describe('the away recap row', () => {
	it('draws the mark, the label and the text, after one blank row', async () => {
		const screen = await show([{ id: 'a', role: 'assistant', content: 'Done.' }, RECAP])
		const rows = screen.scrollback().filter((row) => row.length > 0)
		const index = rows.findIndex((row) => row.includes('recap:'))
		expect(rows[index]).toMatch(/^ ※ recap: Adding retries/u)
		const all = screen.scrollback()
		const at = all.findIndex((row) => row.includes('※'))
		expect(all[at - 1]).toBe('')
		expect(all[at - 2]).toContain('Done.')
	})

	it('has no blank row above it when it is the first row', async () => {
		const screen = await show([RECAP])
		expect(screen.scrollback().findIndex((row) => row.includes('※'))).toBeLessThanOrEqual(1)
	})

	it('bolds the label and not the text', async () => {
		const screen = await show([RECAP])
		const row = screen.viewport().findIndex((text) => text.includes('※'))
		const text = screen.viewport()[row] as string
		const label = text.indexOf('recap:')
		expect(screen.cell(row, label).bold).toBe(true)
		expect(screen.cell(row, label + 8).bold).toBe(false)
	})

	it('wraps long text under the label, not under the mark', async () => {
		const screen = await show([{ ...RECAP, content: 'word '.repeat(40).trim() }], 40)
		const lines = screen.scrollback().filter((row) => row.includes('word'))
		expect(lines.length).toBeGreaterThan(1)
		for (const line of lines.slice(1)) expect(line.startsWith('   ')).toBe(true)
	})
})
