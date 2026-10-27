import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ConfigValueError, loadConfig, mergeUpdatesConfig } from './load.js'

function load(user: string | undefined, project?: unknown) {
	const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
	if (user !== undefined) {
		mkdirSync(join(home, '.namzu'), { recursive: true })
		writeFileSync(join(home, '.namzu', 'config.yaml'), user)
	}
	if (project !== undefined) writeFileSync(join(cwd, 'namzu.config.json'), JSON.stringify(project))
	return loadConfig({ home, cwd, env: {} })
}

describe('the updates setting', () => {
	it('reads all three keys from your own config', () => {
		expect(load('updates:\n  auto: false\n  channel: stable\n  check: true\n').updates).toEqual({
			auto: false,
			channel: 'stable',
			check: true,
		})
	})

	it('is absent when nothing is set', () => {
		expect(load(undefined).updates).toBeUndefined()
	})

	it.each([{ auto: 'yes' }, { check: 1 }, { channel: 'next' }, { interval: 5 }])(
		'refuses %j instead of changing it',
		(updates) => {
			expect(() => load(undefined, { updates })).toThrow(ConfigValueError)
		},
	)

	it('lets a project file turn installing and checking off, never on, and never pick the channel', () => {
		expect(mergeUpdatesConfig({ auto: true }, { auto: false, check: false }, true)).toEqual({
			auto: false,
			check: false,
		})
		expect(
			mergeUpdatesConfig(undefined, { auto: true, channel: 'stable', check: true }, true),
		).toEqual({})
		expect(
			mergeUpdatesConfig({ channel: 'stable' }, { auto: true, channel: 'latest' }, true),
		).toEqual({
			channel: 'stable',
		})
		expect(mergeUpdatesConfig({ auto: false }, { auto: true, channel: 'stable' }, false)).toEqual({
			auto: true,
			channel: 'stable',
		})
	})

	it('applies that rule through the loader', () => {
		const config = load('updates:\n  channel: stable\n', {
			updates: { auto: true, channel: 'latest', check: false },
		})
		expect(config.updates).toEqual({ channel: 'stable', check: false })
	})
})
