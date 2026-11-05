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
		expect(load(`${base}  points:\n    notify-worthy: shadow\n`).decision).toMatchObject({
			points: { 'notify-worthy': 'shadow' },
		})
		const azure =
			'decision:\n  provider: azure\n  endpoint: https://x.example\n  deployment: d\n  points:\n    notify-worthy: on\n'
		expect(load(azure).decision).toMatchObject({ points: { 'notify-worthy': 'on' } })
	})

	it('refuses an unknown point or mode by name', () => {
		expect(() => load(`${base}  points:\n    guess: on\n`)).toThrow(ConfigValueError)
		expect(() => load(`${base}  points:\n    guess: on\n`)).toThrow(/guess/u)
		expect(() => load(`${base}  points:\n    notify-worthy: loud\n`)).toThrow(/off.*shadow.*on/u)
	})
})
