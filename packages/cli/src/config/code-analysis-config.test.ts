import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ConfigValueError, loadConfig } from './load.js'

function setup(user?: unknown, project?: unknown, managed?: unknown) {
	const home = mkdtempSync(join(tmpdir(), 'namzu-analysis-home-'))
	mkdirSync(join(home, '.namzu'), { recursive: true })
	if (user !== undefined) writeFileSync(join(home, '.namzu', 'config.yaml'), JSON.stringify(user))
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-analysis-cwd-'))
	if (project !== undefined) writeFileSync(join(cwd, 'namzu.config.json'), JSON.stringify(project))
	const managedPath = join(cwd, 'managed.json')
	if (managed !== undefined) writeFileSync(managedPath, JSON.stringify(managed))
	return { home, cwd, env: {}, managedPath }
}

describe('codeAnalysis config', () => {
	it('is absent by default, which means the tool is on', () => {
		expect(loadConfig(setup()).codeAnalysis).toBeUndefined()
	})

	it('reads enabled: false', () => {
		expect(loadConfig(setup({ codeAnalysis: { enabled: false } })).codeAnalysis).toEqual({
			enabled: false,
		})
		expect(loadConfig(setup({ codeAnalysis: {} })).codeAnalysis).toEqual({})
	})

	it.each([
		[{ enabled: 'no' }, 'codeAnalysis.enabled'],
		[{ cacheDir: '/x' }, 'codeAnalysis.cacheDir'],
		['off', 'codeAnalysis'],
	])('refuses %j instead of dropping it', (codeAnalysis, path) => {
		let error: unknown
		try {
			loadConfig(setup({ codeAnalysis }))
		} catch (cause) {
			error = cause
		}
		expect(error).toBeInstanceOf(ConfigValueError)
		expect((error as ConfigValueError).settingPath.startsWith(path)).toBe(true)
	})

	it('is not read from the environment', () => {
		const cfg = loadConfig({ ...setup(), env: { NAMZU_CODE_ANALYSIS: '{"enabled":false}' } })
		expect(cfg.codeAnalysis).toBeUndefined()
	})

	it('lets a project turn it off', () => {
		const cfg = loadConfig(setup({}, { codeAnalysis: { enabled: false } }))
		expect(cfg.codeAnalysis?.enabled).toBe(false)
	})

	it('keeps it off when a later file asks for it on', () => {
		const cfg = loadConfig(
			setup({ codeAnalysis: { enabled: false } }, { codeAnalysis: { enabled: true } }),
		)
		expect(cfg.codeAnalysis?.enabled).toBe(false)
	})
})
