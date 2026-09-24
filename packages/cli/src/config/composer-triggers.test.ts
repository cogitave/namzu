/**
 * `composerTriggers`: the shape the loader accepts, and the one rule that
 * matters most — a repository can turn composer triggers down, never up.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { resolveComposerTriggers } from './composer-triggers.js'
import { ConfigValueError, loadConfig, loadConfigWithProvenance } from './load.js'

function layers(options: {
	readonly user?: string
	readonly project?: unknown
	readonly managed?: unknown
}) {
	const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
	mkdirSync(join(home, '.namzu'), { recursive: true })
	if (options.user !== undefined) writeFileSync(join(home, '.namzu', 'config.yaml'), options.user)
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
	if (options.project !== undefined)
		writeFileSync(join(cwd, 'namzu.config.json'), JSON.stringify(options.project))
	const managedPath = join(cwd, 'managed.json')
	if (options.managed !== undefined) writeFileSync(managedPath, JSON.stringify(options.managed))
	return { home, cwd, env: {}, managedPath }
}

const resolved = (options: Parameters<typeof layers>[0], profile?: string) =>
	resolveComposerTriggers(
		loadConfig({ ...layers(options), ...(profile ? { profile } : {}) }).composerTriggers,
	)

describe('composerTriggers shape', () => {
	it('defaults to on, suggesting, both languages, and the built-in armings', () => {
		expect(resolved({})).toEqual({
			enabled: true,
			suggest: true,
			languages: ['en', 'tr'],
			arming: { hypermode: 'arm', 'save-skill': 'arm', schedule: 'suggest', 'max-effort': 'off' },
		})
	})

	it('reads every key from the user file', () => {
		expect(
			loadConfig(
				layers({
					user: 'composerTriggers:\n  enabled: false\n  suggest: false\n  languages: [tr]\n  builtin:\n    max-effort: arm\n',
				}),
			).composerTriggers,
		).toEqual({
			enabled: false,
			suggest: false,
			languages: ['tr'],
			builtin: { 'max-effort': 'arm' },
		})
	})

	it.each([
		['composerTriggers: true\n', 'composerTriggers'],
		['composerTriggers:\n  enabeld: false\n', 'composerTriggers.enabeld'],
		['composerTriggers:\n  enabled: "no"\n', 'composerTriggers.enabled'],
		['composerTriggers:\n  languages: [en, de]\n', 'composerTriggers.languages[1]'],
		['composerTriggers:\n  builtin:\n    ultracode: arm\n', 'composerTriggers.builtin.ultracode'],
		[
			'composerTriggers:\n  builtin:\n    hypermode: always\n',
			'composerTriggers.builtin.hypermode',
		],
	])('refuses %j at %s', (contents, settingPath) => {
		let error: unknown
		try {
			loadConfig(layers({ user: contents }))
		} catch (caught) {
			error = caught
		}
		expect(error).toBeInstanceOf(ConfigValueError)
		expect(error).toMatchObject({ settingPath })
	})

	it('is never read from the environment', () => {
		const options = layers({})
		const config = loadConfig({
			...options,
			env: { NAMZU_COMPOSER_TRIGGERS: 'false', NAMZU_COMPOSER_TRIGGERS_ENABLED: 'false' },
		})
		expect(config.composerTriggers).toBeUndefined()
	})
})

describe('a repository turns triggers down, never up', () => {
	it('cannot switch the feature back on after the user file turned it off', () => {
		expect(
			resolved({
				user: 'composerTriggers:\n  enabled: false\n',
				project: { composerTriggers: { enabled: true, suggest: true } },
			}).enabled,
		).toBe(false)
	})

	it('can turn it off, and lower one trigger', () => {
		expect(resolved({ project: { composerTriggers: { enabled: false } } }).enabled).toBe(false)
		expect(
			resolved({ project: { composerTriggers: { builtin: { hypermode: 'suggest' } } } }).arming
				.hypermode,
		).toBe('suggest')
	})

	it('cannot raise a trigger above its default or above what the user chose', () => {
		const project = {
			composerTriggers: { builtin: { schedule: 'arm', 'max-effort': 'arm', hypermode: 'arm' } },
		}
		const arming = resolved({
			user: 'composerTriggers:\n  builtin:\n    hypermode: suggest\n',
			project,
		}).arming
		expect(arming.schedule).toBe('suggest')
		expect(arming['max-effort']).toBe('off')
		expect(arming.hypermode).toBe('suggest')
	})

	it('cannot add a language the layers below left out', () => {
		expect(
			resolved({
				user: 'composerTriggers:\n  languages: [tr]\n',
				project: { composerTriggers: { languages: ['en', 'tr'] } },
			}).languages,
		).toEqual(['tr'])
	})

	it('cannot raise through a profile it declares either', () => {
		const project = {
			composerTriggers: {},
			profiles: { loud: { composerTriggers: { enabled: true, builtin: { 'max-effort': 'arm' } } } },
		}
		const settings = resolved({ user: 'composerTriggers:\n  enabled: false\n', project }, 'loud')
		expect(settings.enabled).toBe(false)
		expect(settings.arming['max-effort']).toBe('off')
	})

	it('lets the user file raise a default, and a user profile change one key without resetting the rest', () => {
		const user =
			'composerTriggers:\n  builtin:\n    max-effort: arm\n    hypermode: suggest\nprofiles:\n  quiet:\n    composerTriggers:\n      suggest: false\n'
		const settings = resolved({ user }, 'quiet')
		expect(settings.arming['max-effort']).toBe('arm')
		expect(settings.arming.hypermode).toBe('suggest')
		expect(settings.suggest).toBe(false)
	})

	it('lets the managed file force the feature off over everything', () => {
		const settings = resolved({
			user: 'composerTriggers:\n  enabled: true\n',
			managed: { composerTriggers: { enabled: false } },
		})
		expect(settings.enabled).toBe(false)
		const { provenance } = loadConfigWithProvenance(
			layers({ managed: { composerTriggers: { enabled: false } } }),
		)
		expect(provenance.composerTriggers?.kind).toBe('managed')
	})
})
