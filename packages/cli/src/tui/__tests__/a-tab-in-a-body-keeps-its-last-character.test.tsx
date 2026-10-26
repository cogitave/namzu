/**
 * A body line that carries a tab (a file excerpt is numbered `1<TAB>text`)
 * draws every character of the text. The renderer measures a tab as no width
 * while the terminal advances to a tab stop, so a line was cut one cell short.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { Transcript } from '../Transcript.js'
import { TranscriptScreen } from '../TranscriptScreen.js'
import type { TranscriptMessage } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const screens: Screen[] = []
afterEach(async () => {
	for (const screen of screens.splice(0)) await screen.unmount()
})

describe('a body line with a tab', () => {
	for (const cols of [100, 60]) {
		it(`shows the whole line at ${cols} columns`, async () => {
			const message: TranscriptMessage = {
				id: 'r',
				role: 'tool',
				content: 'Read(a.md)',
				glyph: '●',
				detail: ['1\t# Deneme', '2\tconst x = 1', '3\tfoo'],
				detailExpanded: true,
			}
			const screen = await renderToScreen(
				<Transcript messages={[message]} pending={null} state="idle" settled={0} resetKey={0} />,
				{ cols, rows: 30 },
			)
			screens.push(screen)
			await screen.waitForRender()
			const text = screen.viewport().join('\n')
			expect(text).toContain('# Deneme')
			expect(text).toContain('const x = 1')
			expect(text).toMatch(/foo$/m)
		})
	}

	for (const cols of [100, 60]) {
		it(`shows the whole line of a command's output at ${cols} columns`, async () => {
			const message: TranscriptMessage = {
				id: 's',
				role: 'tool',
				content: 'Bash(cat a.md)',
				glyph: '●',
				shell: { stdout: ['1\t# Deneme', '2\tconst x = 1', '3\tfoo'], stderr: [], failed: false },
				detailExpanded: true,
			}
			const screen = await renderToScreen(
				<Transcript messages={[message]} pending={null} state="idle" settled={0} resetKey={0} />,
				{ cols, rows: 30 },
			)
			screens.push(screen)
			await screen.waitForRender()
			const text = screen.viewport().join('\n')
			expect(text).toContain('# Deneme')
			expect(text).toContain('const x = 1')
			expect(text).toMatch(/foo$/m)
		})
	}

	for (const cols of [100, 60]) {
		it(`shows the whole line on the detailed transcript at ${cols} columns`, async () => {
			const message: TranscriptMessage = {
				id: 'r',
				role: 'tool',
				content: 'Read(a.md)',
				glyph: '●',
				detail: ['1\t# Deneme', '2\tconst x = 1', '3\tfoo'],
			}
			const screen = await renderToScreen(
				<TranscriptScreen
					messages={[message]}
					pending={null}
					rows={30}
					columns={cols}
					dialogWaiting={false}
					onClose={() => {}}
				/>,
				{ cols, rows: 30 },
			)
			screens.push(screen)
			await screen.waitForRender()
			const text = screen.viewport().join('\n')
			expect(text).toContain('# Deneme')
			expect(text).toContain('const x = 1')
			expect(text).toMatch(/foo$/m)
		})
	}
})
