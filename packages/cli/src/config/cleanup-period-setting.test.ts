import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { readCleanupPeriod } from '../integrations/sessions/cleanup.js'
import { promptHistoryEnabled } from '../integrations/sessions/prompt-history.js'
import { ConfigValueError, loadConfigWithProvenance } from './load.js'
import { SETTING_DESCRIPTORS } from './settings-descriptors.js'

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

function place(user?: string, project?: string) {
	const home = mkdtempSync(join(tmpdir(), 'namzu-cleanup-setting-home-'))
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-cleanup-setting-cwd-'))
	dirs.push(home, cwd)
	mkdirSync(join(home, '.namzu'), { recursive: true })
	if (user !== undefined) writeFileSync(join(home, '.namzu', 'config.yaml'), user)
	if (project !== undefined) writeFileSync(join(cwd, 'namzu.config.json'), project)
	return { home, cwd }
}

function load(user?: string, project?: string) {
	const { home, cwd } = place(user, project)
	return loadConfigWithProvenance({ home, cwd, env: {}, managedPath: join(cwd, 'managed.json') })
}

describe('cleanupPeriodDays', () => {
	it('is absent by default, which the sweep reads as 30 days nobody chose', () => {
		expect(load().config.cleanupPeriodDays).toBeUndefined()
		const { home } = place()
		expect(readCleanupPeriod({ home, env: {} })).toEqual({ periodDays: 30, explicit: false })
	})

	it('reads a whole number of days of at least one, and says what to do instead of 0', () => {
		expect(load('cleanupPeriodDays: 3650\n').config.cleanupPeriodDays).toBe(3650)
		expect(() => load('cleanupPeriodDays: 0\n')).toThrow(/large number such as 3650/)
		expect(() => load('cleanupPeriodDays: -1\n')).toThrow(ConfigValueError)
		expect(() => load('cleanupPeriodDays: 1.5\n')).toThrow(ConfigValueError)
		expect(() => load('cleanupPeriodDays: thirty\n')).toThrow(ConfigValueError)
	})

	it('is taken from the person’s own file, and is the sweep’s period, set on purpose', () => {
		const { home } = place('cleanupPeriodDays: 7\n')
		expect(readCleanupPeriod({ home, env: {} })).toEqual({ periodDays: 7, explicit: true })
	})

	it('removes nothing when the file cannot be read', () => {
		const { home } = place('cleanupPeriodDays: 0\n')
		expect(readCleanupPeriod({ home, env: {} })).toBeUndefined()
	})

	it('is ignored in a project’s file, with a warning', () => {
		const { config } = load(
			undefined,
			JSON.stringify({ cleanupPeriodDays: 1, promptHistory: false }),
		)
		expect(config.cleanupPeriodDays).toBeUndefined()
		expect(config.promptHistory).toBeUndefined()
	})

	it('is a described setting with its default and a confirmation', () => {
		const found = SETTING_DESCRIPTORS.find((d) => d.path === 'cleanupPeriodDays')
		expect(found?.default).toBe(30)
		expect(found?.control).toMatchObject({ kind: 'number', min: 1, unit: 'days' })
		expect(found?.confirm).toMatch(/cannot be restored/)
	})
})

describe('promptHistory', () => {
	it('is on unless the person turns it off, and off when the file cannot be read', () => {
		expect(promptHistoryEnabled({ home: place().home, env: {} })).toBe(true)
		expect(promptHistoryEnabled({ home: place('promptHistory: false\n').home, env: {} })).toBe(
			false,
		)
		expect(promptHistoryEnabled({ home: place('promptHistory: maybe\n').home, env: {} })).toBe(
			false,
		)
		expect(SETTING_DESCRIPTORS.find((d) => d.path === 'promptHistory')?.default).toBe(true)
	})
})
