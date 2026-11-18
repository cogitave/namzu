import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { resolveProgressNudge } from '../reminders/progress-nudge.js'
import { ConfigValueError, loadConfig } from './load.js'

function setup(user?: unknown, project?: unknown) {
	const home = mkdtempSync(join(tmpdir(), 'namzu-nudge-home-'))
	mkdirSync(join(home, '.namzu'), { recursive: true })
	if (user !== undefined) writeFileSync(join(home, '.namzu', 'config.yaml'), JSON.stringify(user))
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-nudge-cwd-'))
	if (project !== undefined) writeFileSync(join(cwd, 'namzu.config.json'), JSON.stringify(project))
	return { home, cwd, env: {}, managedPath: join(cwd, 'managed.json') }
}

describe('progressNudge config', () => {
	it('is absent by default', () => {
		expect(loadConfig(setup()).progressNudge).toBeUndefined()
	})

	it('reads the mode and the stretch', () => {
		expect(
			loadConfig(setup({ progressNudge: { mode: 'on', afterSeconds: 30, afterCalls: 3 } }))
				.progressNudge,
		).toEqual({ mode: 'on', afterSeconds: 30, afterCalls: 3 })
	})

	it('merges key by key across files', () => {
		const cfg = loadConfig(
			setup({ progressNudge: { afterSeconds: 45 } }, { progressNudge: { mode: 'on' } }),
		)
		expect(cfg.progressNudge).toEqual({ afterSeconds: 45, mode: 'on' })
	})

	it.each([
		[{ mode: 'sometimes' }, 'progressNudge.mode'],
		[{ afterSeconds: 0 }, 'progressNudge.afterSeconds'],
		[{ afterCalls: 2.5 }, 'progressNudge.afterCalls'],
		[{ after: 3 }, 'progressNudge.after'],
		['on', 'progressNudge'],
	])('refuses %j instead of dropping it', (progressNudge, path) => {
		let error: unknown
		try {
			loadConfig(setup({ progressNudge }))
		} catch (cause) {
			error = cause
		}
		expect(error).toBeInstanceOf(ConfigValueError)
		expect((error as ConfigValueError).settingPath.startsWith(path)).toBe(true)
	})

	it('is not read from the environment', () => {
		expect(
			loadConfig({ ...setup(), env: { NAMZU_PROGRESS_NUDGE: '{"mode":"on"}' } }).progressNudge,
		).toBeUndefined()
	})
})

describe('who gets the nudge', () => {
	it('nudges a watched surface by default and an unwatched one never, unless asked', () => {
		expect(resolveProgressNudge(undefined, { watched: true })).toEqual({})
		expect(resolveProgressNudge(undefined, { watched: false })).toBeUndefined()
		expect(resolveProgressNudge({ mode: 'auto' }, { watched: false })).toBeUndefined()
		expect(resolveProgressNudge({ mode: 'on' }, { watched: false })).toEqual({})
	})

	it('is off everywhere when switched off', () => {
		expect(resolveProgressNudge({ mode: 'off' }, { watched: true })).toBeUndefined()
	})

	it('turns seconds into the clock the nudge reads', () => {
		expect(resolveProgressNudge({ afterSeconds: 30, afterCalls: 3 }, { watched: true })).toEqual({
			afterMs: 30_000,
			afterCalls: 3,
		})
	})
})
