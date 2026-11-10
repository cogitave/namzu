import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import { loadConfigWithProvenance, takeConfigWarnings } from './load.js'

/**
 * The sandbox block is the operator's. A repository's two files may tighten it
 * (turn it on, close an escape, require more isolation) and never loosen it;
 * the user file and the managed file keep full control, managed last.
 */

type Files = { user?: unknown; project?: unknown; local?: unknown; managed?: unknown }

function layout(files: Files) {
	const root = mkdtempSync(join(tmpdir(), 'namzu-sandbox-layers-'))
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

function sandboxOf(files: Files, profile?: string) {
	const l = layout(files)
	return loadConfigWithProvenance({
		home: l.home,
		cwd: l.cwd,
		managedPath: l.managedPath,
		env: {},
		...(profile ? { profile } : {}),
	}).config.sandbox
}

beforeEach(() => {
	takeConfigWarnings()
})

const REPO_FILES = ['project', 'local'] as const

describe.each(REPO_FILES)('sandbox in the %s file', (where) => {
	const file = where === 'project' ? 'namzu.config.json' : 'namzu.config.local.json'

	it('cannot switch off a sandbox the user turned on, and says so', () => {
		const sandbox = sandboxOf({
			user: { sandbox: { enabled: true } },
			[where]: { sandbox: { enabled: false } },
		})

		expect(sandbox?.enabled).toBe(true)
		const notes = takeConfigWarnings().join('\n')
		expect(notes).toContain('sandbox.enabled')
		expect(notes).toContain(file)
	})

	it('can switch the sandbox on', () => {
		expect(sandboxOf({ [where]: { sandbox: { enabled: true } } })?.enabled).toBe(true)
		expect(
			sandboxOf({ user: { sandbox: { enabled: false } }, [where]: { sandbox: { enabled: true } } })
				?.enabled,
		).toBe(true)
		expect(takeConfigWarnings()).toEqual([])
	})

	it('cannot grant an unattended escape the user did not, and says so', () => {
		const sandbox = sandboxOf({
			user: { sandbox: { enabled: true } },
			[where]: { sandbox: { allowUnattendedEscape: true } },
		})

		expect(sandbox?.allowUnattendedEscape).not.toBe(true)
		const notes = takeConfigWarnings().join('\n')
		expect(notes).toContain('sandbox.allowUnattendedEscape')
		expect(notes).toContain(file)
	})

	it('cannot grant an unattended escape when no user file speaks either', () => {
		expect(
			sandboxOf({ [where]: { sandbox: { allowUnattendedEscape: true } } })?.allowUnattendedEscape,
		).not.toBe(true)
		expect(takeConfigWarnings().join('\n')).toContain('sandbox.allowUnattendedEscape')
	})

	it('can close the unattended escape the user opened', () => {
		const sandbox = sandboxOf({
			user: { sandbox: { allowUnattendedEscape: true } },
			[where]: { sandbox: { allowUnattendedEscape: false } },
		})

		expect(sandbox?.allowUnattendedEscape).toBe(false)
		expect(takeConfigWarnings()).toEqual([])
	})

	it('cannot turn escapes back on after the user turned them off, and says so', () => {
		const sandbox = sandboxOf({
			user: { sandbox: { allowEscape: false } },
			[where]: { sandbox: { allowEscape: true } },
		})

		expect(sandbox?.allowEscape).toBe(false)
		const notes = takeConfigWarnings().join('\n')
		expect(notes).toContain('sandbox.allowEscape')
		expect(notes).toContain(file)
	})

	it('can turn escapes off', () => {
		expect(
			sandboxOf({
				user: { sandbox: { allowEscape: true } },
				[where]: { sandbox: { allowEscape: false } },
			})?.allowEscape,
		).toBe(false)
		expect(takeConfigWarnings()).toEqual([])
	})

	it('can add required isolation but never remove what the user required', () => {
		const grown = sandboxOf({
			user: { sandbox: { requireIsolation: ['filesystem'] } },
			[where]: { sandbox: { requireIsolation: ['network'] } },
		})
		expect([...(grown?.requireIsolation ?? [])].sort()).toEqual(['filesystem', 'network'])

		const kept = sandboxOf({
			user: { sandbox: { requireIsolation: ['filesystem', 'network'] } },
			[where]: { sandbox: { requireIsolation: [] } },
		})
		expect([...(kept?.requireIsolation ?? [])].sort()).toEqual(['filesystem', 'network'])
	})

	it("can ask for an ephemeral workspace but not undo the user's", () => {
		expect(sandboxOf({ [where]: { sandbox: { workspace: 'ephemeral' } } })?.workspace).toBe(
			'ephemeral',
		)
		takeConfigWarnings()

		const sandbox = sandboxOf({
			user: { sandbox: { workspace: 'ephemeral' } },
			[where]: { sandbox: { workspace: 'working-directory' } },
		})
		expect(sandbox?.workspace).toBe('ephemeral')
		expect(takeConfigWarnings().join('\n')).toContain('sandbox.workspace')
	})

	it('does not change the cleanup time limit the user chose, and says so', () => {
		const sandbox = sandboxOf({
			user: { sandbox: { teardownTimeoutMs: 60000 } },
			[where]: { sandbox: { teardownTimeoutMs: 1 } },
		})

		expect(sandbox?.teardownTimeoutMs).toBe(60000)
		expect(takeConfigWarnings().join('\n')).toContain('sandbox.teardownTimeoutMs')
	})

	it('leaves the rest of the user block alone instead of replacing it', () => {
		const sandbox = sandboxOf({
			user: {
				sandbox: { enabled: true, allowEscape: false, requireIsolation: ['process'] },
			},
			[where]: { sandbox: { workspace: 'ephemeral' } },
		})

		expect(sandbox).toMatchObject({
			enabled: true,
			allowEscape: false,
			requireIsolation: ['process'],
			workspace: 'ephemeral',
		})
	})

	it('says nothing for a loosening that would change nothing', () => {
		sandboxOf({
			user: { sandbox: { allowUnattendedEscape: true } },
			[where]: { sandbox: { allowUnattendedEscape: true } },
		})
		sandboxOf({ [where]: { sandbox: { allowEscape: true } } })
		expect(takeConfigWarnings()).toEqual([])
	})
})

describe('sandbox in a profile', () => {
	it('follows the file that declares it: a project profile cannot loosen', () => {
		const sandbox = sandboxOf(
			{
				user: { sandbox: { enabled: true } },
				project: {
					profiles: { lax: { sandbox: { enabled: false, allowUnattendedEscape: true } } },
				},
			},
			'lax',
		)

		expect(sandbox?.enabled).toBe(true)
		expect(sandbox?.allowUnattendedEscape).not.toBe(true)
		expect(takeConfigWarnings().join('\n')).toContain('sandbox.allowUnattendedEscape')
	})

	it('follows the file that declares it: a user profile keeps full control', () => {
		const sandbox = sandboxOf(
			{
				user: {
					sandbox: { enabled: true },
					profiles: { lax: { sandbox: { enabled: false, allowUnattendedEscape: true } } },
				},
			},
			'lax',
		)

		expect(sandbox?.enabled).toBe(false)
		expect(sandbox?.allowUnattendedEscape).toBe(true)
	})
})

describe('sandbox in a profile by where its file really is', () => {
	it("is the operator's when the declaring file is the managed one, whatever it is named", () => {
		const l = layout({ user: { sandbox: { enabled: true } } })
		const managedDir = join(l.managedPath, '..', 'managed-dir')
		mkdirSync(managedDir, { recursive: true })
		const managedPath = join(managedDir, 'namzu.config.json')
		writeFileSync(
			managedPath,
			JSON.stringify({
				profiles: { lax: { sandbox: { enabled: false, allowUnattendedEscape: true } } },
			}),
			'utf-8',
		)

		const { config } = loadConfigWithProvenance({
			home: l.home,
			cwd: l.cwd,
			managedPath,
			env: {},
			profile: 'lax',
		})

		expect(config.sandbox).toMatchObject({ enabled: false, allowUnattendedEscape: true })
		expect(takeConfigWarnings()).toEqual([])
	})
})

describe('sandbox in the user and managed files', () => {
	it('does not let a user loosening survive a managed block that does not name it', () => {
		const sandbox = sandboxOf({
			user: { sandbox: { enabled: false, allowEscape: true, allowUnattendedEscape: true } },
			managed: { sandbox: { enabled: true } },
		})

		expect(sandbox?.enabled).toBe(true)
		expect(sandbox?.allowUnattendedEscape).not.toBe(true)
		expect(sandbox?.allowEscape).not.toBe(true)
	})

	it('lets the user file loosen anything', () => {
		const sandbox = sandboxOf({
			user: {
				sandbox: {
					enabled: false,
					allowEscape: true,
					allowUnattendedEscape: true,
					workspace: 'working-directory',
					teardownTimeoutMs: 5,
				},
			},
		})

		expect(sandbox).toMatchObject({
			enabled: false,
			allowEscape: true,
			allowUnattendedEscape: true,
			teardownTimeoutMs: 5,
		})
		expect(takeConfigWarnings()).toEqual([])
	})

	it('lets the managed file win over the user and both repository files', () => {
		const sandbox = sandboxOf({
			user: { sandbox: { enabled: false, allowUnattendedEscape: true } },
			project: { sandbox: { enabled: true } },
			local: { sandbox: { allowEscape: false } },
			managed: { sandbox: { enabled: true, allowUnattendedEscape: false, allowEscape: false } },
		})

		expect(sandbox).toMatchObject({
			enabled: true,
			allowUnattendedEscape: false,
			allowEscape: false,
		})
	})

	it('lets the managed file loosen what a repository tightened', () => {
		const sandbox = sandboxOf({
			project: { sandbox: { enabled: true } },
			managed: { sandbox: { enabled: false } },
		})

		expect(sandbox?.enabled).toBe(false)
	})
})
