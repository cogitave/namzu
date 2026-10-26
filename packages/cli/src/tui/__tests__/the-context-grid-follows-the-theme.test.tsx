/**
 * The `/context` grid is drawn through the theme tokens: a theme change repaints
 * it, and the ANSI-only themes ask the terminal for nothing but its sixteen
 * named colours.
 */

import { createRequire } from 'node:module'

import { analyzeContextUsage } from '@namzu/sdk'
import { render } from 'ink-testing-library'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { ContextGridRow } from '../ContextGridRow.js'
import { buildContextView } from '../context-grid.js'
import { resetThemeStore, setThemeSetting } from '../theme-store.js'

const inkRequire = createRequire(createRequire(import.meta.url).resolve('ink'))
const chalk = (await import(inkRequire.resolve('chalk'))).default as { level: number }
const originalLevel = chalk.level

beforeAll(() => {
	chalk.level = 3
})
afterAll(() => {
	chalk.level = originalLevel
})
beforeEach(() => {
	vi.stubEnv('NO_COLOR', undefined)
	vi.stubEnv('FORCE_COLOR', '3')
	vi.stubEnv('TERM', 'xterm-256color')
})
afterEach(() => {
	vi.unstubAllEnvs()
	resetThemeStore()
})

// biome-ignore lint/suspicious/noControlCharactersInRegex: matches colour escapes in a frame.
const LITERAL_COLOUR = /\u001b\[(?:[0-9;]*;)?(?:38|48);(?:5|2);/

const view = buildContextView({
	breakdown: analyzeContextUsage({
		windowTokens: 200_000,
		windowSource: 'auto',
		autoCompact: true,
		contextTokens: 42_000,
		systemPromptTokens: 4_000,
	}),
	windowSource: 'auto',
	autoCompact: true,
	approximate: false,
	terminalColumns: 100,
	sections: [],
	memoryFiles: [],
})

function frame(): string {
	const rendered = render(<ContextGridRow view={view} />)
	const out = rendered.lastFrame() ?? ''
	rendered.unmount()
	return out
}

describe('the context grid and the theme', () => {
	it('uses only named colours under an ANSI-only theme', () => {
		setThemeSetting('dark-ansi')
		const out = frame()
		expect(out).toContain('Context usage')
		expect(out).not.toMatch(LITERAL_COLOUR)
		setThemeSetting('light-ansi')
		expect(frame()).not.toMatch(LITERAL_COLOUR)
	})

	it('is drawn in a different colour once the theme changes', () => {
		setThemeSetting('dark')
		const dark = frame()
		setThemeSetting('light')
		const light = frame()
		expect(dark).toMatch(LITERAL_COLOUR)
		expect(light).not.toBe(dark)
	})
})
