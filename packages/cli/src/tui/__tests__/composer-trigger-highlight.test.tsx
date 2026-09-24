/**
 * The composer draws an armed trigger's words in the trigger colour, bold and
 * underlined, and nothing else: the highlight is cut from the draft before
 * unsafe characters are escaped for the terminal, so an escape sequence
 * earlier in the line cannot push it onto the wrong cells. The tag row sits
 * above the input, inside the frame, on one row, and says its state in words
 * even where colour is refused.
 */

import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { Composer, type ComposerTriggerSettings } from '../Composer.js'
import { compileRegistry } from '../triggers/registry.js'
import { type Screen, renderToScreen } from './support/screen.js'

const TRIGGERS: ComposerTriggerSettings = {
	registry: compileRegistry(),
	suggest: true,
	context: {
		permissionMode: 'prompt',
		sessionHypermode: false,
		effortMenu: true,
		agentTool: true,
		skillCreator: true,
		scheduleTool: true,
	},
	highestEffort: 'xhigh',
}

// The test terminal is a colour TTY; the Vitest process itself usually is
// not. Colour is turned on on Ink's own Chalk instance, as the other colour
// checks do.
const inkRequire = createRequire(createRequire(import.meta.url).resolve('ink'))
const chalk = (await import(inkRequire.resolve('chalk'))).default as { level: number }
const originalColorLevel = chalk.level
beforeAll(() => {
	chalk.level = 3
})
afterAll(() => {
	chalk.level = originalColorLevel
})

let screen: Screen | undefined
afterEach(async () => {
	await screen?.unmount()
	screen = undefined
	vi.unstubAllEnvs()
})

async function typed(text: string, cols = 100) {
	screen = await renderToScreen(<Composer history={[]} onSubmit={vi.fn()} triggers={TRIGGERS} />, {
		cols,
		rows: 12,
	})
	for (const key of text) {
		screen.press(key)
		await screen.waitForRender()
	}
	return screen
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matches terminal style codes.
const STYLE = '(?:\\u001b\\[[0-9;]*m)*'

describe('the highlight', () => {
	it('styles only the keyword', async () => {
		const mounted = await typed('hypermode fix it')
		const bytes = mounted.writes().join('')
		expect(bytes).toMatch(new RegExp(`\\u001b\\[4m${STYLE}hypermode`, 'u'))
		expect(bytes).toMatch(/38;5;117m/u)
		// The rest of the line is not underlined.
		expect(bytes).not.toMatch(new RegExp(`\\u001b\\[4m${STYLE}[^\\u001b]*fix`, 'u'))
	})

	it('lands on the keyword after an escaped control character', async () => {
		// U+202E is drawn as the six characters `\\u{202e}`; offsets into the
		// draft would put the underline on the wrong cells.
		const mounted = await typed('‮hypermode fix it')
		const input = mounted.viewport().find((row) => row.includes('fix it')) ?? ''
		expect(input).toContain('\\u{202e}hypermode fix it')
		const bytes = mounted.writes().join('')
		expect(bytes).toMatch(new RegExp(`\\u001b\\[4m${STYLE}hypermode${STYLE}`, 'u'))
		expect(bytes).not.toMatch(new RegExp(`\\u001b\\[4m${STYLE}\\\\u\\{202e\\}`, 'u'))
	})
})

describe('the tag row', () => {
	it('sits above the input and stays one row at 40 columns', async () => {
		const mounted = await typed('hypermode fix it', 40)
		const rows = mounted.viewport()
		const tag = rows.findIndex((row) => row.includes('✦ hypermode'))
		const input = rows.findIndex((row) => row.includes('fix it'))
		expect(tag).toBeGreaterThanOrEqual(0)
		expect(input).toBe(tag + 1)
	})

	it('says its state in words where colour is refused', async () => {
		vi.stubEnv('NO_COLOR', '1')
		const mounted = await typed('what is hypermode?')
		expect(mounted.viewport().join('\n')).toContain('✧ hypermode? · alt+w arms')
	})

	it('drops and restores with Alt+W, and Backspace after the keyword drops it first', async () => {
		const mounted = await typed('hypermode fix it')
		mounted.press('\u001bw')
		await mounted.waitForRender()
		expect(mounted.viewport().join('\n')).toContain('✧ hypermode (off) · alt+w restores')
		mounted.press('\u001bw')
		await mounted.waitForRender()
		expect(mounted.viewport().join('\n')).toContain('✦ hypermode · this turn')

		await mounted.unmount()
		const again = await typed('hypermode')
		again.press('\u007f')
		await again.waitForRender()
		const text = again.viewport().join('\n')
		// Dropped, and not one character deleted.
		expect(text).toContain('✧ hypermode (off)')
		expect(text).toContain('hypermode▏')
	})
})
