/**
 * What the conversation shows of a message the person sent: all of it, pasted
 * lines included, until it passes 10,000 characters.
 */

import { Box } from 'ink'
import { afterEach, describe, expect, it } from 'vitest'

import { Transcript } from '../Transcript.js'
import { estimateRenderedLines, transcriptLines } from '../live-window.js'
import type { TranscriptMessage } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

let mounted: Screen | undefined
afterEach(async () => {
	await mounted?.unmount()
	mounted = undefined
})

async function show(content: string, cols = 80) {
	const messages: TranscriptMessage[] = [{ id: 'u', role: 'user', content }]
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
		{ cols, rows: 200, scrollback: 1000 },
	)
	return mounted.scrollback().join('\n')
}

describe('a sent message', () => {
	it('echoes forty pasted lines in full', async () => {
		const text = Array.from({ length: 40 }, (_, i) => `pasted line ${i + 1} with some words`).join(
			'\n',
		)
		const shown = await show(`please read this\n${text}`)
		expect(shown).toContain('pasted line 1 with')
		expect(shown).toContain('pasted line 40 with')
		expect(shown).not.toContain('hidden')
	})

	it('shows the first and last 2,500 characters of a very long one with a note between', async () => {
		const middle = Array.from({ length: 800 }, (_, i) => `middle-${i}`).join('\n')
		const text = `START ${'a'.repeat(2_400)}\n${middle}\n${'z'.repeat(2_400)} END`
		const shown = await show(text)
		expect(shown).toContain('START')
		expect(shown).toContain('END')
		expect(shown).not.toContain('middle-400')
		expect(shown).toMatch(/\(\d+ lines, ~\d+ KB hidden\)/u)
	})

	it('is counted by the rows it will draw, not by its length', () => {
		const text = `${'a'.repeat(2_500)}\n${'m\n'.repeat(20_000)}${'z'.repeat(2_500)}`
		const counted = estimateRenderedLines(
			transcriptLines([{ id: 'u', role: 'user', content: text }]),
			80,
		)
		expect(counted).toBeLessThan(200)
	})
})
