import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { loadConfigWithProvenance } from './load.js'

/**
 * `computerUse` decides whether the screen can be driven at all, so the file it comes from
 * decides what stands: a repository cannot turn it on, and cannot take an app off the list.
 */

function layout(files: { user?: unknown; project?: unknown; local?: unknown; managed?: unknown }) {
	const root = mkdtempSync(join(tmpdir(), 'namzu-computer-use-settings-'))
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

describe('computerUse.enabled', () => {
	it('is absent when no file says anything', () => {
		expect(load(layout({})).computerUse).toBeUndefined()
	})

	it('is honoured from the user file and the managed file', () => {
		expect(load(layout({ user: { computerUse: { enabled: true } } })).computerUse?.enabled).toBe(
			true,
		)
		expect(load(layout({ managed: { computerUse: { enabled: true } } })).computerUse?.enabled).toBe(
			true,
		)
	})

	it('cannot be turned on by a project file or a local one', () => {
		const config = load(
			layout({
				project: { computerUse: { enabled: true } },
				local: { computerUse: { enabled: true } },
			}),
		)
		expect(config.computerUse?.enabled).toBeUndefined()
	})

	it('can be closed by a project file over the user file', () => {
		const config = load(
			layout({
				user: { computerUse: { enabled: true } },
				project: { computerUse: { enabled: false } },
			}),
		)
		expect(config.computerUse?.enabled).toBe(false)
	})

	it('lets the administrator close it over the user value', () => {
		const config = load(
			layout({
				user: { computerUse: { enabled: true } },
				managed: { computerUse: { enabled: false } },
			}),
		)
		expect(config.computerUse?.enabled).toBe(false)
	})

	it('must be true or false, and the table may hold only its own keys', () => {
		expect(() => load(layout({ user: { computerUse: { enabled: 'yes' } } }))).toThrow(
			/enabled.*true or false/s,
		)
		expect(() => load(layout({ user: { computerUse: { sites: [] } } }))).toThrow(
			/not a computer use setting/,
		)
	})
})

describe('computerUse.deniedApps', () => {
	it('adds up across files and no file removes another file’s entry', () => {
		const config = load(
			layout({
				user: { computerUse: { enabled: true, deniedApps: ['Banking', 'Mail'] } },
				project: { computerUse: { deniedApps: ['mail', 'Chat'] } },
			}),
		)
		expect(config.computerUse?.deniedApps).toEqual(['Banking', 'Mail', 'Chat'])
	})

	it('is honoured from a project file, because it only closes a door', () => {
		expect(
			load(layout({ project: { computerUse: { deniedApps: ['Chat'] } } })).computerUse?.deniedApps,
		).toEqual(['Chat'])
	})

	it('must be a list of names', () => {
		expect(() => load(layout({ user: { computerUse: { deniedApps: 'Chat' } } }))).toThrow(
			/list of application names/,
		)
		expect(() => load(layout({ user: { computerUse: { deniedApps: [' '] } } }))).toThrow(
			/1 to 200 characters/,
		)
	})
})

describe('computerUse.browserWindows', () => {
	it('is absent unless a file says it, and reads look, ask and act', () => {
		expect(
			load(layout({ user: { computerUse: { enabled: true } } })).computerUse,
		).not.toHaveProperty('browserWindows')
		for (const value of ['look', 'ask', 'act'] as const)
			expect(
				load(layout({ user: { computerUse: { browserWindows: value } } })).computerUse
					?.browserWindows,
			).toBe(value)
	})

	it('refuses any other value', () => {
		expect(() => load(layout({ user: { computerUse: { browserWindows: 'always' } } }))).toThrow(
			/look, ask or act/,
		)
	})

	it('cannot be loosened by a project file, only tightened', () => {
		expect(
			load(
				layout({
					user: { computerUse: { browserWindows: 'ask' } },
					project: { computerUse: { browserWindows: 'act' } },
				}),
			).computerUse?.browserWindows,
		).toBe('ask')
		expect(
			load(layout({ project: { computerUse: { browserWindows: 'act' } } })).computerUse
				?.browserWindows,
		).toBeUndefined()
		expect(
			load(
				layout({
					user: { computerUse: { browserWindows: 'act' } },
					project: { computerUse: { browserWindows: 'look' } },
				}),
			).computerUse?.browserWindows,
		).toBe('look')
	})

	it('lets the administrator set it over the user value', () => {
		expect(
			load(
				layout({
					user: { computerUse: { browserWindows: 'act' } },
					managed: { computerUse: { browserWindows: 'look' } },
				}),
			).computerUse?.browserWindows,
		).toBe('look')
	})
})
