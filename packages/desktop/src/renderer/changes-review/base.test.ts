import { describe, expect, it } from 'vitest'
import {
	type BaseContext,
	baseRows,
	chipLabel,
	effectiveBase,
	matchBranches,
	matchCommits,
	sourceOf,
} from './base.js'

const repo: BaseContext = { repository: true, defaultBranch: 'main' }

describe('the base in effect', () => {
	it('reads the conversation’s own edits without a repository', () => {
		const none: BaseContext = { repository: false, defaultBranch: null }
		expect(effectiveBase({ kind: 'all' }, none)).toBe('conversation')
		expect(sourceOf({ kind: 'uncommitted' }, none)).toEqual({ via: 'receipts' })
		expect(chipLabel({ kind: 'all' }, none).text).toBe('Conversation edits')
	})

	it('falls back to uncommitted changes when no usual branch exists', () => {
		const ctx = { repository: true, defaultBranch: null }
		expect(effectiveBase({ kind: 'all' }, ctx)).toEqual({ kind: 'uncommitted' })
		expect(chipLabel({ kind: 'all' }, ctx).text).toBe('HEAD → working tree')
	})

	it('maps each choice to where its files come from', () => {
		expect(sourceOf({ kind: 'uncommitted' }, repo)).toEqual({ via: 'host' })
		expect(sourceOf({ kind: 'all' }, repo)).toEqual({
			via: 'compare',
			base: { kind: 'branch', ref: 'main' },
		})
		expect(sourceOf({ kind: 'branch', ref: 'dev' }, repo)).toEqual({
			via: 'compare',
			base: { kind: 'branch', ref: 'dev' },
		})
		expect(sourceOf({ kind: 'commit', sha: 'abc1234' }, repo)).toEqual({
			via: 'compare',
			base: { kind: 'commit', sha: 'abc1234' },
		})
	})
})

describe('the chip', () => {
	it('names base and working tree, or the commit subject', () => {
		expect(chipLabel({ kind: 'all' }, repo)).toMatchObject({ from: 'main', to: 'working tree' })
		expect(chipLabel({ kind: 'branch', ref: 'origin/dev' }, repo).from).toBe('origin/dev')
		expect(chipLabel({ kind: 'commit', sha: 'abc1234', subject: 'Fix the thing' }, repo).text).toBe(
			'Fix the thing',
		)
		expect(chipLabel({ kind: 'commit', sha: 'abc1234' }, repo).text).toBe('(no message)')
	})
})

describe('the menu rows', () => {
	it('offers All changes vs the base and Uncommitted changes, checking the one in effect', () => {
		const { rows, compare } = baseRows({ kind: 'all' }, repo)
		expect(compare).toBe(true)
		expect(rows).toEqual([
			{ id: 'all', label: 'All changes', hint: 'vs main', checked: true },
			{ id: 'uncommitted', label: 'Uncommitted changes', checked: false },
		])
	})

	it('drops All changes when there is no usual branch, and Compare against without a repository', () => {
		expect(
			baseRows({ kind: 'uncommitted' }, { repository: true, defaultBranch: null }).rows,
		).toEqual([{ id: 'uncommitted', label: 'Uncommitted changes', checked: true }])
		expect(baseRows({ kind: 'all' }, { repository: false, defaultBranch: null }).compare).toBe(
			false,
		)
	})
})

describe('branch and commit search', () => {
	const branches = [{ name: 'dev' }, { name: 'feature/x' }, { name: 'main' }]
	it('puts the usual and current branches first and filters by text', () => {
		expect(matchBranches(branches, '', ['main', 'dev']).map((b) => b.name)).toEqual([
			'main',
			'dev',
			'feature/x',
		])
		expect(matchBranches(branches, 'FEAT', ['main']).map((b) => b.name)).toEqual(['feature/x'])
	})

	it('matches commit subjects and hashes from seven characters', () => {
		const commits = [
			{ sha: 'a'.repeat(40), short: 'aaaaaaa', subject: 'Fix login' },
			{ sha: 'b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0', short: 'b1c2d3e', subject: 'Add docs' },
		]
		expect(matchCommits(commits, 'login')).toHaveLength(1)
		expect(matchCommits(commits, 'b1c2d3e4f')).toHaveLength(1)
		expect(matchCommits(commits, 'b1c')).toHaveLength(1)
		expect(matchCommits(commits, 'zzz')).toHaveLength(0)
		expect(matchCommits(commits, '')).toHaveLength(2)
	})
})
