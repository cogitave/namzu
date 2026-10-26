/**
 * What the block says about a directory, and what it refuses to claim.
 *
 * The facts here are read from a real repository created in a temp directory
 * rather than from a stubbed git: the two calls this makes are the part that
 * can be wrong on a real machine, and a fake `git` proves only that the
 * composer agrees with itself.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { PermissionMode } from '../../permissions/mode.js'

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
	removeTempDir(root)
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

describe('what the permission sentence says per mode', () => {
	const facts: EnvironmentFacts = { today: '2026-10-26', branch: 'main', isRepository: true }
	const host = (mode: PermissionMode | undefined, interactive = true): string =>
		composeEnvironmentPrompt({
			...facts,
			boundary: { escape: 'refused', interactive, ...(mode ? { mode } : {}) },
		})

	it('stays general when the mode is not known', () => {
		expect(host(undefined)).toContain('which may ask the user before they run')
	})

	it('does not say a mode that never asks may ask', () => {
		for (const mode of ['bypass', 'strict', 'auto', 'plan'] as const) {
			expect(host(mode), mode).not.toContain('may ask the user before they run')
		}
	})

	it('tells a sub-agent whose decision a call is, not that it may ask the user', () => {
		const text = composeEnvironmentPrompt({
			...facts,
			boundary: { escape: 'refused', interactive: true, delegated: true },
		})
		expect(text).toContain('follow the permission mode of the session that started you')
		expect(text).toContain('You have no one to ask yourself')
		expect(text).not.toContain('may ask the user')
	})

	it('says each mode in its own words', () => {
		expect(host('prompt')).toContain('put to the user before they run')
		expect(host('accept-edits')).toContain('run without asking')
		expect(host('plan')).toContain('plan mode')
		expect(host('classify')).toContain(
			'checked automatically instead, and some may still be refused',
		)
		expect(host('strict')).toContain('Only preapproved tools run')
		expect(host('auto')).toContain('Nobody is asked')
	})

	it('keeps the safety rules in view when prompts are off', () => {
		const text = host('bypass')
		expect(text).toContain('calls run without asking')
		expect(text).toContain('What always needs the user still does')
		expect(text).toContain('safety rules apply as usual')
	})

	it('says a call that would ask is refused when nobody is at the terminal', () => {
		for (const mode of ['prompt', 'accept-edits', 'classify'] as const) {
			expect(host(mode, false), mode).toContain('Nobody is at the terminal')
			expect(host(mode, true), mode).not.toContain('Nobody is at the terminal')
		}
	})

	it('leaves the sandbox sentence to the backend, not the mode', () => {
		const text = composeEnvironmentPrompt({
			...facts,
			boundary: {
				sandbox: { environment: 'linux-bwrap', enforced: ['filesystem'] },
				escape: 'ask',
				interactive: true,
				mode: 'bypass',
			},
		})
		expect(text).toContain('Shell commands run in a sandbox (linux-bwrap')
		expect(text).not.toContain('Tools run on this machine')
	})
})
