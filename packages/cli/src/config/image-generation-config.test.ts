import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ConfigValueError, loadConfig } from './load.js'

function setup(user?: unknown, project?: unknown, managed?: unknown) {
	const home = mkdtempSync(join(tmpdir(), 'namzu-imagegen-home-'))
	mkdirSync(join(home, '.namzu'), { recursive: true })
	if (user !== undefined) writeFileSync(join(home, '.namzu', 'config.yaml'), JSON.stringify(user))
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-imagegen-cwd-'))
	if (project !== undefined) writeFileSync(join(cwd, 'namzu.config.json'), JSON.stringify(project))
	const managedPath = join(cwd, 'managed.json')
	if (managed !== undefined) writeFileSync(managedPath, JSON.stringify(managed))
	return { home, cwd, env: {}, managedPath }
}

describe('imageGeneration config', () => {
	it('is absent by default, which means the tool is offered', () => {
		expect(loadConfig(setup()).imageGeneration).toBeUndefined()
	})

	it('reads enabled: false', () => {
		expect(loadConfig(setup({ imageGeneration: { enabled: false } })).imageGeneration).toEqual({
			enabled: false,
		})
		expect(loadConfig(setup({ imageGeneration: {} })).imageGeneration).toEqual({})
	})

	it.each([
		[{ enabled: 'no' }, 'imageGeneration.enabled'],
		[{ model: '/x' }, 'imageGeneration.model'],
		['off', 'imageGeneration'],
	])('refuses %j instead of dropping it', (imageGeneration, path) => {
		let error: unknown
		try {
			loadConfig(setup({ imageGeneration }))
		} catch (cause) {
			error = cause
		}
		expect(error).toBeInstanceOf(ConfigValueError)
		expect((error as ConfigValueError).settingPath.startsWith(path)).toBe(true)
	})

	it('is not read from the environment', () => {
		const cfg = loadConfig({ ...setup(), env: { NAMZU_IMAGE_GENERATION: '{"enabled":false}' } })
		expect(cfg.imageGeneration).toBeUndefined()
	})

	it('lets a project turn it off', () => {
		const cfg = loadConfig(setup({}, { imageGeneration: { enabled: false } }))
		expect(cfg.imageGeneration?.enabled).toBe(false)
	})

	it('keeps it off when a later file asks for it on', () => {
		const cfg = loadConfig(
			setup({ imageGeneration: { enabled: false } }, { imageGeneration: { enabled: true } }),
		)
		expect(cfg.imageGeneration?.enabled).toBe(false)
	})
})
