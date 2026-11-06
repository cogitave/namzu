import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ConfigValueError, loadConfig } from './load.js'

function load(user: string) {
	const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
	mkdirSync(join(home, '.namzu'), { recursive: true })
	writeFileSync(join(home, '.namzu', 'config.yaml'), user)
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
	return loadConfig({ home, cwd, env: {}, managedPath: join(cwd, 'managed.json') })
}

const base = 'decision:\n  provider: http\n  url: http://localhost:9\n'

describe('decision.points', () => {
	it('is absent unless the file names it, so every point is off', () => {
		expect(load(base).decision).toEqual({ provider: 'http', url: 'http://localhost:9' })
	})

	it('reads a mode per point for either provider', () => {
		expect(load(`${base}  points:\n    notify: shadow\n`).decision).toMatchObject({
			points: { notify: 'shadow' },
		})
		const azure =
			'decision:\n  provider: azure\n  endpoint: https://x.example\n  deployment: d\n  points:\n    notify: on\n'
		expect(load(azure).decision).toMatchObject({ points: { notify: 'on' } })
	})

	it('knows the memory point too, and names every point when it refuses one', () => {
		expect(load(`${base}  points:\n    memory: shadow\n`).decision).toMatchObject({
			points: { memory: 'shadow' },
		})
		expect(() => load(`${base}  points:\n    guess: on\n`)).toThrow(/notify, memory, skill/u)
	})

	it('refuses an unknown point or mode by name', () => {
		expect(() => load(`${base}  points:\n    guess: on\n`)).toThrow(ConfigValueError)
		expect(() => load(`${base}  points:\n    guess: on\n`)).toThrow(/guess/u)
		expect(() => load(`${base}  points:\n    notify: loud\n`)).toThrow(/off.*shadow.*on/u)
	})
})

describe('decision azure authentication', () => {
	const azure = 'decision:\n  provider: azure\n  endpoint: https://x.example\n  deployment: d\n'

	it('reads an API key variable', () => {
		expect(load(`${azure}  apiKeyEnv: FOUNDRY_KEY\n`).decision).toMatchObject({
			apiKeyEnv: 'FOUNDRY_KEY',
		})
	})

	it('refuses a config that names both a key and a token variable', () => {
		expect(() => load(`${azure}  apiKeyEnv: K\n  tokenEnv: T\n`)).toThrow(/apiKeyEnv/u)
	})
})

describe('the old point names', () => {
	const base = 'decision:\n  provider: http\n  url: http://localhost:9\n'

	it('still work, and read as the one-word point', () => {
		expect(
			load(
				`${base}  points:\n    notify-worthy: shadow\n    memory-admit: on\n    skill-worthy: off\n`,
			).decision,
		).toMatchObject({ points: { notify: 'shadow', memory: 'on', skill: 'off' } })
	})

	it('are refused beside the new name for the same point', () => {
		expect(() => load(`${base}  points:\n    notify: on\n    notify-worthy: shadow\n`)).toThrow(
			/second time/u,
		)
	})
})
