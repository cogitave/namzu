import { describe, expect, it } from 'vitest'

import { type GitRun, parseRemoteUrl, readWorkspaceGit } from './workspace-git.js'

describe('parseRemoteUrl', () => {
	it.each([
		['https://github.com/cogitave/namzu.git', 'github.com', 'cogitave', 'namzu'],
		['https://github.com/cogitave/namzu', 'github.com', 'cogitave', 'namzu'],
		['git@github.com:cogitave/namzu.git', 'github.com', 'cogitave', 'namzu'],
		['ssh://git@gitlab.example/team/proj.git', 'gitlab.example', 'team', 'proj'],
	])('%s', (url, host, owner, name) => {
		expect(parseRemoteUrl(url)).toEqual({ host, owner, name })
	})

	it('is nothing for what is not a remote', () => {
		expect(parseRemoteUrl('')).toBeUndefined()
		expect(parseRemoteUrl('/srv/git/repo')).toBeUndefined()
	})
})

describe('readWorkspaceGit', () => {
	it('names a linked worktree and the origin repo', async () => {
		const git: GitRun = async (args) =>
			args[0] === 'rev-parse'
				? '/r/.git/worktrees/feat\n/r/.git\n/r/.claude/worktrees/feat\n'
				: 'git@github.com:o/n.git\n'
		expect(await readWorkspaceGit('/r/.claude/worktrees/feat', git)).toEqual({
			gitWorktree: 'feat',
			repo: { host: 'github.com', owner: 'o', name: 'n' },
		})
	})

	it('names no worktree in the main checkout, and nothing outside a repository', async () => {
		const main: GitRun = async (args) =>
			args[0] === 'rev-parse' ? '.git\n.git\n/r\n' : Promise.reject(new Error('no origin'))
		expect(await readWorkspaceGit('/r', main)).toEqual({})
		const none: GitRun = async () => {
			throw new Error('not a repository')
		}
		expect(await readWorkspaceGit('/x', none)).toEqual({})
	})
})
