import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ConfigLoadError, ConfigValueError, loadConfigWithProvenance } from './load.js'

/**
 * Two layers with opposite jobs.
 *
 * A PROFILE is a choice the operator makes and can un-make. It has to beat the
 * ambient values in its own file, or selecting it would do nothing; and lose to
 * the environment, or a variable set for one shell would stop working the
 * moment somebody picked a profile.
 *
 * A MANAGED file is a choice made for them. It has to beat everything, or it is
 * a suggestion wearing the word "managed".
 *
 * Both are only worth having if the boot log and `/status` can say which one
 * decided a value, so the provenance assertions here are not incidental.
 */

interface Layout {
	readonly home: string
	readonly cwd: string
	readonly managedPath: string
}

function layout(files: { user?: unknown; project?: unknown; managed?: unknown }): Layout {
	const root = mkdtempSync(join(tmpdir(), 'namzu-profiles-'))
	const home = join(root, 'home')
	const cwd = join(root, 'work')
	const managedDir = join(root, 'managed')
	mkdirSync(join(home, '.namzu'), { recursive: true })
	mkdirSync(cwd, { recursive: true })
	mkdirSync(managedDir, { recursive: true })

	if (files.user !== undefined) {
		writeFileSync(join(home, '.namzu', 'config.yaml'), JSON.stringify(files.user), 'utf-8')
	}
	if (files.project !== undefined) {
		writeFileSync(join(cwd, 'namzu.config.json'), JSON.stringify(files.project), 'utf-8')
	}
	const managedPath = join(managedDir, 'config.json')
	if (files.managed !== undefined)
		writeFileSync(managedPath, JSON.stringify(files.managed), 'utf-8')
	return { home, cwd, managedPath }
}

function load(l: Layout, over: { profile?: string; env?: NodeJS.ProcessEnv } = {}) {
	return loadConfigWithProvenance({
		home: l.home,
		cwd: l.cwd,
		managedPath: l.managedPath,
		env: over.env ?? {},
		...(over.profile !== undefined ? { profile: over.profile } : {}),
	})
}

describe('a profile is not applied until it is selected', () => {
	it('leaves the base values alone when none is named', () => {
		const l = layout({ project: { quiet: false, profiles: { ci: { quiet: true } } } })

		expect(load(l).config.quiet).toBe(false)
	})

	it('overrides the file it was declared in', () => {
		// The load-bearing one. A profile that lost to its own file's base
		// values could never change anything, and selecting it would be a
		// no-op reported as success.
		const l = layout({ project: { quiet: false, profiles: { ci: { quiet: true } } } })

		expect(load(l, { profile: 'ci' }).config.quiet).toBe(true)
	})

	it('can be selected from the environment', () => {
		const l = layout({ project: { quiet: false, profiles: { ci: { quiet: true } } } })

		expect(load(l, { env: { NAMZU_PROFILE: 'ci' } }).config.quiet).toBe(true)
	})

	it('prefers the flag over the variable, because a flag is this run', () => {
		const l = layout({ project: { profiles: { a: { format: 'json' }, b: { format: 'yaml' } } } })

		expect(load(l, { profile: 'a', env: { NAMZU_PROFILE: 'b' } }).config.format).toBe('json')
	})

	it('loses to the environment, which is narrower than a chosen bundle', () => {
		// A variable set for one shell must keep working after somebody picks a
		// profile, or the two features fight and the operator loses.
		const l = layout({ project: { profiles: { ci: { format: 'json' } } } })

		const { config, provenance } = load(l, { profile: 'ci', env: { NAMZU_FORMAT: 'yaml' } })

		expect(config.format).toBe('yaml')
		expect(provenance.format).toMatchObject({ kind: 'env' })
	})

	it('refuses an invalid known value in an unselected profile when the file loads', () => {
		const l = layout({ project: { profiles: { ci: { format: 'xml' } } } })

		let error: unknown
		try {
			load(l)
		} catch (cause) {
			error = cause
		}
		expect(error).toBeInstanceOf(ConfigValueError)
		expect(error).toMatchObject({ settingPath: 'profiles.ci.format' })
	})

	it('refuses a profile that recursively declares profiles', () => {
		const l = layout({ project: { profiles: { ci: { profiles: { nested: {} } } } } })

		expect(() => load(l)).toThrow(/profiles\.ci\.profiles cannot be declared inside a profile/)
	})

	it('accepts unknown profile keys without merging them into the typed config', () => {
		const l = layout({ project: { profiles: { ci: { futureSetting: true, quiet: true } } } })

		const { config } = load(l, { profile: 'ci' })
		expect(config.quiet).toBe(true)
		expect('futureSetting' in config).toBe(false)
	})
})

describe('the same profile in two files', () => {
	it('lets the project file win, as its base values do', () => {
		const l = layout({
			user: { profiles: { ci: { format: 'json' } } },
			project: { profiles: { ci: { format: 'yaml' } } },
		})

		expect(load(l, { profile: 'ci' }).config.format).toBe('yaml')
	})

	it('names the file a value came from, not just "the profile"', () => {
		// One layer per file exists for this. Reporting both as "profile ci"
		// would leave an operator opening the wrong file to change it.
		const l = layout({
			user: { profiles: { ci: { quiet: true } } },
			project: { profiles: { ci: { format: 'yaml' } } },
		})

		const { provenance } = load(l, { profile: 'ci' })

		expect(provenance.quiet).toMatchObject({ kind: 'profile', name: 'ci' })
		expect((provenance.quiet as { path: string }).path).toContain('config.yaml')
		expect((provenance.format as { path: string }).path).toContain('namzu.config.json')
	})
})

describe('a profile nothing declares', () => {
	it('is refused rather than ignored', () => {
		// Ignoring it means running under settings nobody chose and reporting
		// success. The cost of refusing is one retyped word.
		const l = layout({ project: { profiles: { ci: { quiet: true } } } })

		expect(() => load(l, { profile: 'revew' })).toThrow(ConfigLoadError)
	})

	it('lists the names that do exist, since the mistake is usually a typo', () => {
		const l = layout({ project: { profiles: { ci: {}, review: {} } } })

		expect(() => load(l, { profile: 'revew' })).toThrow(/ci, review/)
	})

	it('says plainly when no file declares any profile at all', () => {
		// A different mistake with a different fix: the operator is in the
		// wrong folder, or has not written the profile yet.
		const l = layout({ project: { quiet: true } })

		expect(() => load(l, { profile: 'ci' })).toThrow(/no config file declares any profiles/i)
	})

	it.each(['toString', 'constructor', '__proto__'])(
		'refuses inherited Object.prototype name %s from the flag-equivalent option',
		(name) => {
			const l = layout({ project: { profiles: { safe: { quiet: true } } } })

			expect(() => load(l, { profile: name })).toThrow(ConfigLoadError)
		},
	)

	it.each(['toString', 'constructor', '__proto__'])(
		'refuses inherited Object.prototype name %s from NAMZU_PROFILE',
		(name) => {
			const l = layout({ project: { profiles: { safe: { quiet: true } } } })

			expect(() => load(l, { env: { NAMZU_PROFILE: name } })).toThrow(ConfigLoadError)
		},
	)

	it.each(['toString', 'constructor', '__proto__'])(
		'allows %s when the file declares it as an own profile',
		(name) => {
			const profiles = Object.create(null) as Record<string, unknown>
			profiles[name] = { format: 'json' }
			const l = layout({ project: { profiles } })

			expect(load(l, { profile: name }).config.format).toBe('json')
		},
	)
})

describe('the managed file wins', () => {
	it('beats the project file', () => {
		const l = layout({ project: { format: 'json' }, managed: { format: 'yaml' } })

		expect(load(l).config.format).toBe('yaml')
	})

	it('beats the environment, which is the only ordering worth having', () => {
		// If a variable could override it, it would be a suggestion wearing the
		// word "managed".
		const l = layout({ managed: { format: 'yaml' } })

		const { config, provenance } = load(l, { env: { NAMZU_FORMAT: 'json' } })

		expect(config.format).toBe('yaml')
		expect(provenance.format).toMatchObject({ kind: 'managed' })
	})

	it('beats a selected profile', () => {
		const l = layout({
			project: { profiles: { ci: { format: 'json' } } },
			managed: { format: 'yaml' },
		})

		expect(load(l, { profile: 'ci' }).config.format).toBe('yaml')
	})

	it('is absent on almost every machine, which is not an error', () => {
		const l = layout({ project: { format: 'json' } })

		expect(load(l).config.format).toBe('json')
	})

	it('may declare profiles of its own', () => {
		const l = layout({ managed: { profiles: { locked: { quiet: true } } } })

		expect(load(l, { profile: 'locked' }).config.quiet).toBe(true)
	})
})
