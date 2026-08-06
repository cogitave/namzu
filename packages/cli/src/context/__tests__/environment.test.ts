/**
 * What the block says about a directory, and what it refuses to claim.
 *
 * The facts here are read from a real repository created in a temp directory
 * rather than from a stubbed git: the two calls this makes are the part that
 * can be wrong on a real machine, and a fake `git` proves only that the
 * composer agrees with itself.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	type EnvironmentFacts,
	composeEnvironmentPrompt,
	localIsoDate,
	readEnvironmentFacts,
} from '../environment.js'

let root: string

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-env-'))
})

afterEach(() => {
	rmSync(root, { recursive: true, force: true })
})

function initRepo(dir: string, branch: string): void {
	mkdirSync(dir, { recursive: true })
	execFileSync('git', ['init', '--quiet'], { cwd: dir })
	// `checkout -b` on an unborn HEAD, so no commit and no identity config are
	// needed — and it is the case `rev-parse --abbrev-ref HEAD` cannot answer,
	// which is why the reader uses `symbolic-ref`.
	execFileSync('git', ['checkout', '-q', '-b', branch], { cwd: dir })
}

describe('the date', () => {
	it('is the local calendar date, not the UTC one', () => {
		// A machine behind UTC would otherwise be told it is tomorrow, and would
		// write tomorrow's date into a changelog — the exact mistake this block
		// exists to prevent, made by the block.
		const lateEvening = new Date(2026, 7, 6, 23, 30, 0)

		expect(localIsoDate(lateEvening)).toBe('2026-08-06')
	})

	it('zero-pads a single-digit month and day', () => {
		expect(localIsoDate(new Date(2026, 0, 5))).toBe('2026-01-05')
	})
})

describe('the repository', () => {
	it('reports the branch that is checked out', async () => {
		const repo = join(root, 'repo')
		initRepo(repo, 'feature/parser')

		const facts = await readEnvironmentFacts(repo)

		expect(facts.isRepository).toBe(true)
		expect(facts.branch).toBe('feature/parser')
		expect(composeEnvironmentPrompt(facts)).toContain('feature/parser')
	})

	it('says a directory is not a repository rather than staying quiet', async () => {
		const plain = join(root, 'plain')
		mkdirSync(plain)

		const facts = await readEnvironmentFacts(plain)

		expect(facts.isRepository).toBe(false)
		expect(facts.branch).toBeNull()
		expect(composeEnvironmentPrompt(facts)).toContain('not a git repository')
	})

	it('distinguishes a detached HEAD from not being a repository at all', async () => {
		// The two collapse into one if the reader only asks `symbolic-ref`, and
		// the difference is load-bearing: a commit made on a detached HEAD is not
		// reachable from any branch, which an agent about to commit should be
		// told.
		const facts: EnvironmentFacts = { today: '2026-08-06', branch: 'detached', isRepository: true }

		const prompt = composeEnvironmentPrompt(facts)

		expect(prompt).toContain('detached HEAD')
		expect(prompt).toContain('not reachable from any branch')
		expect(prompt).not.toContain('not a git repository')
	})
})

describe('what the block does not claim', () => {
	it('says nothing about uncommitted changes', async () => {
		// Deliberate. This text is the CACHED prefix of every request, and a
		// dirty-file count changes whenever the agent saves a file — carrying it
		// would re-key the cache on essentially every turn to say something
		// `git status` answers on demand. If a reader adds it, this test is what
		// tells them the cost.
		const repo = join(root, 'repo')
		initRepo(repo, 'main')

		const prompt = composeEnvironmentPrompt(await readEnvironmentFacts(repo))

		expect(prompt).not.toMatch(/uncommitted|modified file|dirty/i)
	})
})
