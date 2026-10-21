import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { compilePermissions } from '../permissions/rules.js'
import { loadConfigWithProvenance } from './load.js'

/**
 * The mode settings share the `permissions` table with the tool rules, and the
 * file they came from decides which of them stand: a repository cannot make a
 * clone of itself start without asking.
 */

function layout(files: { user?: unknown; project?: unknown; local?: unknown; managed?: unknown }) {
	const root = mkdtempSync(join(tmpdir(), 'namzu-permission-settings-'))
	const home = join(root, 'home')
	const cwd = join(root, 'work')
	mkdirSync(join(home, '.namzu'), { recursive: true })
	mkdirSync(cwd, { recursive: true })
	if (files.user !== undefined)
		writeFileSync(join(home, '.namzu', 'config.yaml'), JSON.stringify(files.user), 'utf-8')
	if (files.project !== undefined)
		writeFileSync(join(cwd, 'namzu.config.json'), JSON.stringify(files.project), 'utf-8')
	if (files.local !== undefined)
		writeFileSync(join(cwd, 'namzu.config.local.json'), JSON.stringify(files.local), 'utf-8')
	const managedPath = join(root, 'managed.json')
	if (files.managed !== undefined)
		writeFileSync(managedPath, JSON.stringify(files.managed), 'utf-8')
	return { home, cwd, managedPath }
}

const load = (l: ReturnType<typeof layout>) =>
	loadConfigWithProvenance({ home: l.home, cwd: l.cwd, managedPath: l.managedPath, env: {} }).config

describe('permissions.defaultMode', () => {
	it('is honoured from the user file, bypass and auto included', () => {
		expect(
			load(layout({ user: { permissions: { defaultMode: 'bypass' } } })).permissionSettings,
		).toEqual({ defaultMode: 'bypass' })
		expect(
			load(layout({ user: { permissions: { defaultMode: 'auto' } } })).permissionSettings,
		).toEqual({ defaultMode: 'auto' })
	})

	it('is honoured from the managed file, which wins over the user file', () => {
		const config = load(
			layout({
				user: { permissions: { defaultMode: 'prompt' } },
				managed: { permissions: { defaultMode: 'bypass' } },
			}),
		)

		expect(config.permissionSettings?.defaultMode).toBe('bypass')
	})

	it.each(['project', 'local'] as const)(
		'is ignored for bypass and auto in the %s file, and said so',
		(where) => {
			for (const mode of ['bypass', 'auto']) {
				const config = load(layout({ [where]: { permissions: { defaultMode: mode } } }))

				expect(config.permissionSettings?.defaultMode).toBeUndefined()
				expect(config.permissionSettings?.ignored?.join(' ')).toContain(
					`permissions.defaultMode: "${mode}"`,
				)
			}
		},
	)

	it('lets a project pick a stricter default', () => {
		const config = load(layout({ project: { permissions: { defaultMode: 'accept-edits' } } }))

		expect(config.permissionSettings).toEqual({ defaultMode: 'accept-edits' })
	})

	it('does not let a project undo the user’s own default', () => {
		const config = load(
			layout({
				user: { permissions: { defaultMode: 'bypass' } },
				project: { permissions: { defaultMode: 'bypass' } },
			}),
		)

		expect(config.permissionSettings?.defaultMode).toBe('bypass')
	})

	it('refuses a word that is not a mode, naming the file', () => {
		expect(() => load(layout({ user: { permissions: { defaultMode: 'yolo' } } }))).toThrow(
			/permissions\.defaultMode.*must be one of: prompt, accept-edits, plan, bypass, auto, strict/s,
		)
	})
})

describe('permissions.disableBypassMode and disableAutoMode', () => {
	it('can be written by any file, because they only close a door', () => {
		const config = load(
			layout({
				project: { permissions: { disableBypassMode: true } },
				local: { permissions: { disableAutoMode: true } },
			}),
		)

		expect(config.permissionSettings).toEqual({ disableBypassMode: true, disableAutoMode: true })
	})

	it('stay on once a file set them', () => {
		const config = load(
			layout({
				user: { permissions: { disableBypassMode: true } },
				managed: { permissions: { disableBypassMode: false } },
			}),
		)

		expect(config.permissionSettings?.disableBypassMode).toBe(true)
	})

	it('must be true or false', () => {
		expect(() => load(layout({ user: { permissions: { disableBypassMode: 'yes' } } }))).toThrow(
			/disableBypassMode.*true or false/s,
		)
	})
})

describe('permissions.autoMode', () => {
	const autoMode = {
		model: 'small-model',
		allow: ['$defaults', 'Running our deploy script to staging.'],
		softDeny: ['Anything that touches the billing service.'],
		hardDeny: ['$defaults'],
		environment: ['Our organisation is Acme.'],
	}

	it('is read from the user file with its lists intact', () => {
		const config = load(layout({ user: { permissions: { autoMode } } }))

		expect(config.permissionSettings?.autoMode).toEqual(autoMode)
	})

	it('is ignored in a project file, which would otherwise choose where the conversation goes', () => {
		const config = load(layout({ project: { permissions: { autoMode } } }))

		expect(config.permissionSettings?.autoMode).toBeUndefined()
		expect(config.permissionSettings?.ignored?.join(' ')).toContain('permissions.autoMode')
	})

	it('names the setting that is wrong', () => {
		expect(() =>
			load(layout({ user: { permissions: { autoMode: { allow: 'everything' } } } })),
		).toThrow(/autoMode\.allow.*list of sentences/s)
		expect(() => load(layout({ user: { permissions: { autoMode: { modle: 'x' } } } }))).toThrow(
			/autoMode\.modle.*not an auto mode setting/s,
		)
	})
})

describe('the settings and the tool rules', () => {
	it('keep the settings out of the rule table and the rules in it', () => {
		const config = load(
			layout({
				user: { permissions: { defaultMode: 'bypass', bash: { 'npm test*': 'allow' } } },
			}),
		)

		expect(config.permissions).toEqual({ bash: { 'npm test*': 'allow' } })
		expect(config.permissionLayers).toEqual([{ bash: { 'npm test*': 'allow' } }])
	})

	it('are skipped, not reported as bad rules, by the compiler', () => {
		const compiled = compilePermissions({
			defaultMode: 'bypass',
			autoMode: { model: 'x' },
			bash: 'ask',
		} as never)

		expect(compiled.diagnostics).toEqual([])
		expect(compiled.rules.length).toBeGreaterThan(0)
	})

	it('are not a config key of their own', () => {
		expect(() => load(layout({ user: { permissionSettings: { defaultMode: 'bypass' } } }))).toThrow(
			/permissionSettings/,
		)
	})
})
