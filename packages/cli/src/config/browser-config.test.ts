import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ConfigValueError, loadConfig } from './load.js'

function setup(user?: unknown, project?: unknown, managed?: unknown) {
	const home = mkdtempSync(join(tmpdir(), 'namzu-browser-home-'))
	mkdirSync(join(home, '.namzu'), { recursive: true })
	if (user !== undefined) writeFileSync(join(home, '.namzu', 'config.yaml'), JSON.stringify(user))
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-browser-cwd-'))
	if (project !== undefined) writeFileSync(join(cwd, 'namzu.config.json'), JSON.stringify(project))
	const managedPath = join(cwd, 'managed.json')
	if (managed !== undefined) writeFileSync(managedPath, JSON.stringify(managed))
	return { home, cwd, env: {}, managedPath }
}

describe('browser config', () => {
	it('reads every key and canonicalises site keys', () => {
		const cfg = loadConfig(
			setup({
				browser: {
					enabled: true,
					defaultProfile: 'work',
					engine: 'windows',
					headless: 'never',
					keepOpen: true,
					sites: { 'HTTPS://GitHub.com/': 'act', 'https://*.Example.com': 'read', '*': 'deny' },
				},
			}),
		)
		expect(cfg.browser).toEqual({
			enabled: true,
			defaultProfile: 'work',
			engine: 'windows',
			headless: 'never',
			keepOpen: true,
			sites: { 'https://github.com': 'act', 'https://*.example.com': 'read', '*': 'deny' },
		})
	})

	it.each([
		[{ sites: { 'https://git*hub.com': 'act' } }, 'browser.sites'],
		[{ sites: { 'file:///etc': 'read' } }, 'browser.sites'],
		[{ sites: { 'https://a.example': 'allow' } }, 'browser.sites'],
		[{ defaultProfile: 'Work Profile' }, 'browser.defaultProfile'],
		[{ engine: 'chrome' }, 'browser.engine'],
		[{ headless: true }, 'browser.headless'],
		[{ enabled: 'yes' }, 'browser.enabled'],
		[{ profile: 'x' }, 'browser.profile'],
	])('refuses %j instead of dropping it', (browser, path) => {
		let error: unknown
		try {
			loadConfig(setup({ browser }))
		} catch (cause) {
			error = cause
		}
		expect(error).toBeInstanceOf(ConfigValueError)
		expect((error as ConfigValueError).settingPath.startsWith(path)).toBe(true)
	})

	it('is not read from the environment', () => {
		const opts = setup()
		const cfg = loadConfig({ ...opts, env: { NAMZU_BROWSER: '{"enabled":true}' } })
		expect(cfg.browser).toBeUndefined()
	})

	it('merges a project over the user file per key and per site', () => {
		const cfg = loadConfig(
			setup(
				{
					browser: {
						headless: 'always',
						defaultProfile: 'work',
						sites: { 'https://github.com': 'act', 'https://bank.example': 'deny' },
					},
				},
				{
					browser: {
						headless: 'never',
						sites: { 'https://github.com': 'read', 'https://docs.example': 'act' },
					},
				},
			),
		)
		expect(cfg.browser).toEqual({
			headless: 'never',
			defaultProfile: 'work',
			sites: {
				'https://github.com': 'read',
				'https://bank.example': 'deny',
				'https://docs.example': 'act',
			},
		})
	})

	it('does not let a project reopen a site the user denied, in any spelling', () => {
		const cfg = loadConfig(
			setup(
				{ browser: { sites: { 'https://bank.example': 'deny' } } },
				{ browser: { sites: { 'HTTPS://BANK.example:443': 'act' } } },
			),
		)
		expect(cfg.browser?.sites).toEqual({ 'https://bank.example': 'deny' })
	})

	it('does not let a project add sites when the user denied every other one', () => {
		const cfg = loadConfig(
			setup(
				{ browser: { sites: { 'https://github.com': 'read', '*': 'deny' } } },
				{ browser: { sites: { 'https://evil.example': 'act', '*': 'act' } } },
			),
		)
		expect(cfg.browser?.sites).toEqual({ 'https://github.com': 'read', '*': 'deny' })
	})

	it('keeps the browser off when any file switched it off', () => {
		expect(
			loadConfig(setup({ browser: { enabled: false } }, { browser: { enabled: true } })).browser
				?.enabled,
		).toBe(false)
		expect(
			loadConfig(setup({ browser: { enabled: true } }, undefined, { browser: { enabled: false } }))
				.browser?.enabled,
		).toBe(false)
	})

	it('holds a managed deny over both files', () => {
		const cfg = loadConfig(
			setup(
				{ browser: { sites: { 'https://github.com': 'act' } } },
				{ browser: { sites: { 'https://github.com': 'act' } } },
				{ browser: { sites: { 'https://github.com': 'deny' } } },
			),
		)
		expect(cfg.browser?.sites).toEqual({ 'https://github.com': 'deny' })
	})

	it('refuses a profile chosen by a project file', () => {
		expect(() => loadConfig(setup(undefined, { browser: { defaultProfile: 'work' } }))).toThrow(
			/a profile holds your sign-ins/,
		)
		expect(() =>
			loadConfig({
				...setup(undefined, {
					profiles: { ci: { browser: { defaultProfile: 'work' } } },
				}),
				profile: 'ci',
			}),
		).toThrow(/a profile holds your sign-ins/)
	})
})
