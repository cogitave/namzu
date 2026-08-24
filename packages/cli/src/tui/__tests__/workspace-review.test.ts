import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { listReviewBranches, listReviewCommits, reviewMergeBase } from '../workspace-review.js'

const roots: string[] = []

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: '/dev/null',
			GIT_CONFIG_NOSYSTEM: '1',
		},
	}).trim()
}

function repository(): {
	readonly root: string
	readonly firstSha: string
	readonly secondSha: string
} {
	const root = mkdtempSync(join(tmpdir(), 'namzu-review-'))
	roots.push(root)
	git(root, 'init', '--quiet', '--initial-branch=main')
	git(root, 'config', 'user.name', 'Namzu Test')
	git(root, 'config', 'user.email', 'test@example.invalid')
	writeFileSync(join(root, 'source.ts'), 'export const value = 1\n')
	git(root, 'add', 'source.ts')
	git(root, 'commit', '--quiet', '-m', 'first change')
	const firstSha = git(root, 'rev-parse', 'HEAD')
	git(root, 'branch', 'release')
	writeFileSync(join(root, 'source.ts'), 'export const value = 2\n')
	git(root, 'commit', '--quiet', '-am', 'second change')
	return { root, firstSha, secondSha: git(root, 'rev-parse', 'HEAD') }
}

describe('workspace review targets', () => {
	it('lists local branches and recent commits with immutable ids', async () => {
		const repo = repository()

		await expect(listReviewBranches(repo.root)).resolves.toEqual({
			current: 'main',
			branches: ['main', 'release'],
		})
		await expect(listReviewCommits(repo.root)).resolves.toEqual([
			{ sha: repo.secondSha, title: 'second change' },
			{ sha: repo.firstSha, title: 'first change' },
		])
	})

	it('resolves the selected branch to its exact merge base', async () => {
		const repo = repository()
		await expect(reviewMergeBase(repo.root, 'release')).resolves.toBe(repo.firstSha)
		await expect(reviewMergeBase(repo.root, 'does-not-exist')).resolves.toBeNull()
	})

	it('refuses a directory that cannot establish repository targets', async () => {
		const root = mkdtempSync(join(tmpdir(), 'namzu-review-empty-'))
		roots.push(root)
		await expect(listReviewBranches(root)).resolves.toBeNull()
		await expect(listReviewCommits(root)).resolves.toBeNull()
		await expect(reviewMergeBase(root, 'main')).resolves.toBeNull()
	})
})
