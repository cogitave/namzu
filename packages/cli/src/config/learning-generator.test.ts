import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { resolveGeneratorSettings } from '../integrations/learning/generator-settings.js'
import { ConfigValueError, loadConfig } from './load.js'

function layers(options: { user?: string; project?: unknown; env?: Record<string, string> } = {}) {
	const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
	mkdirSync(join(home, '.namzu'), { recursive: true })
	if (options.user !== undefined) writeFileSync(join(home, '.namzu', 'config.yaml'), options.user)
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
	if (options.project !== undefined)
		writeFileSync(join(cwd, 'namzu.config.json'), JSON.stringify(options.project))
	return { home, cwd, env: options.env ?? {}, managedPath: join(cwd, 'managed.json') }
}
const settings = (options?: Parameters<typeof layers>[0]) =>
	resolveGeneratorSettings(loadConfig(layers(options)).learningGenerator)

describe('learningGenerator', () => {
	it('is on by default, with the default caps', () => {
		expect(loadConfig(layers()).learningGenerator).toBeUndefined()
		expect(settings()).toEqual({ enabled: true, cycleTokens: 120_000, dailyTokens: 300_000 })
	})

	it('turns off with false and on again with true', () => {
		expect(settings({ user: 'learningGenerator: false\n' }).enabled).toBe(false)
		expect(settings({ user: 'learningGenerator: true\n' }).enabled).toBe(true)
	})

	it('reads a mapping with its own caps', () => {
		expect(
			settings({ user: 'learningGenerator:\n  cycleTokens: 50000\n  dailyTokens: 90000\n' }),
		).toEqual({ enabled: true, cycleTokens: 50_000, dailyTokens: 90_000 })
	})

	it('names the setting when a value is wrong', () => {
		for (const [yaml, path] of [
			['learningGenerator: "no"\n', 'learningGenerator'],
			['learningGenerator:\n  cycleTokens: 5\n', 'learningGenerator.cycleTokens'],
			['learningGenerator:\n  dailyTokens: 1.5\n', 'learningGenerator.dailyTokens'],
			['learningGenerator:\n  enabled: 1\n', 'learningGenerator.enabled'],
			['learningGenerator:\n  budget: 3\n', 'learningGenerator.budget'],
		] as const) {
			const error = (() => {
				try {
					loadConfig(layers({ user: yaml }))
				} catch (e) {
					return e
				}
			})()
			expect(error).toBeInstanceOf(ConfigValueError)
			expect(error).toMatchObject({ settingPath: path })
		}
	})

	it('is not settable from the environment', () => {
		expect(settings({ env: { NAMZU_LEARNING_GENERATOR: 'false' } }).enabled).toBe(true)
	})

	it('lets a project file turn learning down but never up', () => {
		expect(
			settings({ user: 'learningGenerator: true\n', project: { learningGenerator: false } })
				.enabled,
		).toBe(false)
		expect(
			settings({ user: 'learningGenerator: false\n', project: { learningGenerator: true } })
				.enabled,
		).toBe(false)
		expect(
			settings({
				user: 'learningGenerator:\n  cycleTokens: 50000\n',
				project: { learningGenerator: { cycleTokens: 900000, dailyTokens: 5000000 } },
			}),
		).toEqual({ enabled: true, cycleTokens: 50_000, dailyTokens: 300_000 })
		expect(settings({ project: { learningGenerator: { cycleTokens: 10000 } } }).cycleTokens).toBe(
			10_000,
		)
	})
})
