import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { RECAP_WAIT_MS } from './away-recap.js'
import {
	describeRecapSetting,
	recapEnabled,
	recapWaitMs,
	setRecapSetting,
} from './recap-setting.js'

describe('whether the recap is on', () => {
	const on = { env: {}, tui: undefined, interactive: true }

	it('is on by default and only the literal false turns it off', () => {
		expect(recapEnabled(on)).toBe(true)
		expect(recapEnabled({ ...on, tui: {} })).toBe(true)
		expect(recapEnabled({ ...on, tui: { recap: true } })).toBe(true)
		expect(recapEnabled({ ...on, tui: { recap: false } })).toBe(false)
	})

	it.each(['0', 'false', 'no', 'off', ' OFF '])('turns off for NAMZU_RECAP=%j', (word) => {
		expect(recapEnabled({ ...on, env: { NAMZU_RECAP: word } })).toBe(false)
	})

	it.each(['1', 'true', 'yes', 'on'])('turns on for NAMZU_RECAP=%j over the setting', (word) => {
		expect(recapEnabled({ ...on, env: { NAMZU_RECAP: word }, tui: { recap: false } })).toBe(true)
	})

	it('ignores a word it does not know', () => {
		expect(recapEnabled({ ...on, env: { NAMZU_RECAP: 'maybe' } })).toBe(true)
		expect(recapEnabled({ ...on, env: { NAMZU_RECAP: 'maybe' }, tui: { recap: false } })).toBe(
			false,
		)
	})

	it('never recaps a run with no screen unless the environment insists', () => {
		expect(recapEnabled({ ...on, interactive: false })).toBe(false)
		expect(recapEnabled({ ...on, interactive: false, env: { NAMZU_RECAP: '1' } })).toBe(true)
	})
})

describe('changing it', () => {
	function home(): { home: string; env: NodeJS.ProcessEnv; file: string } {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-recap-'))
		return { home: dir, env: { NAMZU_HOME: dir }, file: join(dir, 'config.yaml') }
	}

	it('off writes tui.recap: false and keeps the rest of the file', () => {
		const { home: dir, env, file } = home()
		writeFileSync(file, '# mine\ntui:\n  notifications: true\n')
		expect(setRecapSetting(false, { home: dir, env })).toMatch(/off/u)
		const text = readFileSync(file, 'utf8')
		expect(text).toContain('# mine')
		expect(text).toContain('notifications: true')
		expect(text).toMatch(/recap: false/u)
	})

	it('on removes the key', () => {
		const { home: dir, env, file } = home()
		writeFileSync(file, 'tui:\n  recap: false\n  notifications: true\n')
		expect(setRecapSetting(true, { home: dir, env })).toMatch(/on/u)
		const text = readFileSync(file, 'utf8')
		expect(text).not.toContain('recap')
		expect(text).toContain('notifications: true')
	})

	it('on with no file is fine', () => {
		const { home: dir, env } = home()
		expect(setRecapSetting(true, { home: dir, env })).toMatch(/Recaps are on/u)
	})

	it('says when the environment decides otherwise', () => {
		const { home: dir } = home()
		const env = { NAMZU_HOME: dir, NAMZU_RECAP: '1' }
		expect(setRecapSetting(false, { home: dir, env })).toMatch(/NAMZU_RECAP.*on/u)
	})

	it('says what could not be saved, in words', () => {
		const { home: dir, env, file } = home()
		writeFileSync(file, 'tui: [unclosed')
		expect(setRecapSetting(false, { home: dir, env })).toMatch(/until it ends/u)
	})

	it('lists what is in force', () => {
		const text = describeRecapSetting({ enabledNow: false, env: { NAMZU_RECAP: 'off' }, tui: {} })
		expect(text).toMatch(/off in this conversation/u)
		expect(text).toMatch(/NAMZU_RECAP/u)
	})
})

describe('the wait', () => {
	it('is three minutes unless the environment names milliseconds', () => {
		expect(recapWaitMs({})).toBe(RECAP_WAIT_MS)
		expect(recapWaitMs({ NAMZU_RECAP_WAIT_MS: '2500' })).toBe(2500)
		expect(recapWaitMs({ NAMZU_RECAP_WAIT_MS: '0' })).toBe(0)
		for (const bad of ['', '-5', '1.5', 'soon', '12345678901']) {
			expect(recapWaitMs({ NAMZU_RECAP_WAIT_MS: bad })).toBe(RECAP_WAIT_MS)
		}
	})
})
