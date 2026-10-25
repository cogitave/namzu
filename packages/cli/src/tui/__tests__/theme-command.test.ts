import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { loadConfig } from '../../config/load.js'
import { reducedMotion, setReducedMotion } from '../motion.js'
import { parseThemeArgument, saveReducedMotion, saveTheme } from '../theme-command.js'
import { applyLaunchTheme } from '../theme-launch.js'
import { resetThemeStore, savedThemeSetting, shownTheme } from '../theme-store.js'

let home: string

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-theme-'))
})
afterEach(() => {
	removeTempDir(home)
	resetThemeStore()
	setReducedMotion(false)
})

describe('saving', () => {
	it('writes tui.theme and keeps the rest of the file', () => {
		writeFileSync(join(home, 'config.yaml'), '# mine\nmodelCatalogueRefresh: false\n')
		expect(saveTheme('light', { env: { NAMZU_HOME: home } })).toBe('Theme set to Light mode.')
		const text = readFileSync(join(home, 'config.yaml'), 'utf8')
		expect(text).toContain('# mine')
		expect(text).toContain('modelCatalogueRefresh: false')
		expect(text).toMatch(/tui:\n\s+theme: light/)
		expect(shownTheme()).toBe('light')
		expect(savedThemeSetting()).toBe('light')
		expect(loadConfig({ cwd: tmpdir(), env: { NAMZU_HOME: home } }).tui).toEqual({ theme: 'light' })
	})

	it('still changes the screen when the file cannot be written', () => {
		writeFileSync(join(home, 'config.yaml'), 'a: [unclosed\n')
		const said = saveTheme('dark-ansi', { env: { NAMZU_HOME: home } })
		expect(said).toContain('until Namzu closes')
		expect(shownTheme()).toBe('dark-ansi')
	})

	it('writes tui.reducedMotion', () => {
		expect(saveReducedMotion(true, { env: { NAMZU_HOME: home } })).toContain('Reduced motion is on')
		expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toMatch(/reducedMotion: true/)
		expect(reducedMotion()).toBe(true)
		saveReducedMotion(false, { env: { NAMZU_HOME: home } })
		expect(reducedMotion()).toBe(false)
	})
})

describe('the argument', () => {
	it('takes one exact name', () => {
		expect(parseThemeArgument(['LIGHT'])).toBe('light')
		expect(parseThemeArgument(['auto'])).toBe('auto')
		expect(parseThemeArgument(['solarized'])).toBeUndefined()
		expect(parseThemeArgument([])).toBeUndefined()
		expect(parseThemeArgument(['light', 'dark'])).toBeUndefined()
	})
})

describe('at launch', () => {
	it('applies a named theme and the motion setting', async () => {
		await applyLaunchTheme({ theme: 'light-ansi', reducedMotion: true }, undefined, {})
		expect(shownTheme()).toBe('light-ansi')
		expect(reducedMotion()).toBe(true)
	})

	it('defaults to dark with motion on', async () => {
		await applyLaunchTheme(undefined, undefined, {})
		expect(shownTheme()).toBe('dark')
		expect(reducedMotion()).toBe(false)
	})

	it('uses COLORFGBG for auto when there is no terminal to ask', async () => {
		await applyLaunchTheme({ theme: 'auto' }, undefined, { COLORFGBG: '0;15' })
		expect(shownTheme()).toBe('light')
	})

	it('takes the terminal’s own report for auto', async () => {
		const { EventEmitter } = await import('node:events')
		const input = Object.assign(new EventEmitter(), {
			isTTY: true,
			isRaw: false,
			setRawMode() {},
			pause() {},
			resume() {},
		})
		const output = {
			isTTY: true,
			write() {
				queueMicrotask(() => input.emit('data', Buffer.from('\x1b]11;rgb:ffff/ffff/ffff\x07')))
			},
		}
		await applyLaunchTheme({ theme: 'auto' }, { input, output }, { COLORFGBG: '15;0' })
		expect(shownTheme()).toBe('light')
	})
})
