/**
 * A row written under one theme is drawn in the colours of the theme that is
 * active when it is drawn: its mark keeps no colour from the day it was made.
 * Colours are asserted as the escape codes chalk writes.
 */

import { createRequire } from 'node:module'

import { render } from 'ink-testing-library'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { Transcript } from '../Transcript.js'
import { systemRowStyle } from '../system-rows.js'
import { ThemeEpochContext, resetThemeStore, setThemeSetting } from '../theme-store.js'
import { tokenColor } from '../theme.js'
import type { TranscriptMessage } from '../types.js'

const inkRequire = createRequire(createRequire(import.meta.url).resolve('ink'))
const chalk = (await import(inkRequire.resolve('chalk'))).default as { level: number }
const originalLevel = chalk.level

beforeAll(() => {
	chalk.level = 3
})
afterAll(() => {
	chalk.level = originalLevel
})
afterEach(() => resetThemeStore())

const notice = systemRowStyle('notice')
const rows: TranscriptMessage[] = [
	{
		id: 'm1',
		role: 'system',
		content: 'Theme set to Light mode.',
		glyph: notice.glyph,
		glyphColor: notice.color,
	},
	{
		id: 'm2',
		role: 'tool',
		content: 'Read(a.ts)',
		glyph: '●',
		glyphColor: tokenColor('status.error'),
	},
]

function draw(epoch: number) {
	return (
		<ThemeEpochContext.Provider value={epoch}>
			<Transcript messages={rows} pending={null} state="idle" settled={0} resetKey={0} />
		</ThemeEpochContext.Provider>
	)
}

describe('a row already on screen', () => {
	it('repaints its mark in the theme that is active when it is drawn', () => {
		setThemeSetting('dark', { env: {} })
		const view = render(draw(0))
		const dark = view.lastFrame() ?? ''
		// The dark notice mark is ansi256(245) and the error mark ansi256(203).
		expect(dark).toContain('38;5;245m')
		expect(dark).toContain('38;5;203m')

		setThemeSetting('light', { env: {} })
		view.rerender(draw(1))
		const light = view.lastFrame() ?? ''
		// The light palette's muted text is ansi256(243); no dark colour is left on the rows.
		expect(light).toContain('38;5;243m')
		expect(light).not.toContain('38;5;245m')
		expect(light).not.toContain('38;5;203m')
		view.unmount()
	})

	it('keeps a colour that was not a token', () => {
		setThemeSetting('dark', { env: {} })
		const view = render(
			<Transcript
				messages={[{ id: 'x', role: 'tool', content: 'x', glyph: '●', glyphColor: 'ansi256(99)' }]}
				pending={null}
				state="idle"
				settled={0}
				resetKey={0}
			/>,
		)
		expect(view.lastFrame()).toContain('38;5;99m')
		view.unmount()
	})
})
