import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ConfigValueError, loadConfig } from './load.js'
import { SETTING_DESCRIPTORS } from './settings-descriptors.js'
import {
	branchPrefixProblem,
	sparseFolderPath,
	sparseFolderProblem,
	worktreeLocationProblem,
} from './worktree-settings.js'

function load(user?: string, project?: string) {
	const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
	mkdirSync(join(home, '.namzu'), { recursive: true })
	if (user !== undefined) writeFileSync(join(home, '.namzu', 'config.yaml'), user)
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
	if (project !== undefined) writeFileSync(join(cwd, 'namzu.config.json'), project)
	return loadConfig({ home, cwd, env: {}, managedPath: join(cwd, 'managed.json') })
}

describe('worktree settings rules', () => {
	it('accepts a plain branch prefix and refuses the rest in plain words', () => {
		expect(branchPrefixProblem('ada')).toBeUndefined()
		expect(branchPrefixProblem('team_1.x-y')).toBeUndefined()
		expect(branchPrefixProblem('a'.repeat(40))).toBeUndefined()
		expect(branchPrefixProblem('')).toMatch(/Write a name/)
		expect(branchPrefixProblem('a'.repeat(41))).toMatch(/40/)
		expect(branchPrefixProblem('a/b')).toMatch(/slashes/)
		expect(branchPrefixProblem('a b')).toMatch(/spaces/)
		expect(branchPrefixProblem('-x')).toMatch(/Start with/)
		expect(branchPrefixProblem('x.lock')).toMatch(/Git does not allow/)
		expect(branchPrefixProblem('Main')).toMatch(/already keeps/)
	})

	it('refuses a worktree folder that is relative, missing, a file or not writable', () => {
		const root = mkdtempSync(join(tmpdir(), 'namzu-loc-'))
		writeFileSync(join(root, 'file.txt'), 'x')
		expect(worktreeLocationProblem(root)).toBeUndefined()
		expect(worktreeLocationProblem('relative/dir')).toMatch(/full path/)
		expect(worktreeLocationProblem(join(root, 'gone'))).toMatch(/does not exist/)
		expect(worktreeLocationProblem(join(root, 'file.txt'))).toMatch(/file, not a folder/)
	})

	it('keeps a sparse folder inside the project', () => {
		expect(sparseFolderProblem('src/app')).toBeUndefined()
		expect(sparseFolderProblem('/etc')).toMatch(/inside the project/)
		expect(sparseFolderProblem('../up')).toMatch(/leaves the project/)
		expect(sparseFolderProblem('src/*')).toMatch(/wildcard/)
		expect(sparseFolderPath('./src\\app/')).toBe('src/app')
	})
})

describe('worktrees and archiveInactive in the config file', () => {
	it('reads them from the user file', () => {
		const config = load(
			'worktrees:\n  branchPrefix: ada\n  location: /tmp\n  sparseFolders: [src]\narchiveInactive: 7d\n',
		)
		expect(config.worktrees).toEqual({
			branchPrefix: 'ada',
			location: '/tmp',
			sparseFolders: ['src'],
		})
		expect(config.archiveInactive).toBe('7d')
	})

	it('refuses a bad value naming the rule', () => {
		expect(() => load('worktrees:\n  branchPrefix: a/b\n')).toThrow(ConfigValueError)
		expect(() => load('worktrees:\n  location: relative\n')).toThrow(ConfigValueError)
		expect(() => load('archiveInactive: 2d\n')).toThrow(ConfigValueError)
	})

	it('ignores worktrees in a project file: a repository does not choose where Namzu writes', () => {
		const config = load(undefined, '{"worktrees":{"location":"/tmp","branchPrefix":"evil"}}')
		expect(config.worktrees).toBeUndefined()
	})

	it('describes the four rows with their defaults', () => {
		const rows = SETTING_DESCRIPTORS.filter(
			(d) => d.path.startsWith('worktrees.') || d.path === 'archiveInactive',
		)
		expect(rows.map((d) => d.path).sort()).toEqual([
			'archiveInactive',
			'worktrees.branchPrefix',
			'worktrees.location',
			'worktrees.sparseFolders',
		])
		expect(rows.find((d) => d.path === 'worktrees.location')?.control).toMatchObject({
			kind: 'text',
			picker: 'folder',
		})
		expect(rows.find((d) => d.path === 'archiveInactive')?.default).toBe('never')
	})
})
