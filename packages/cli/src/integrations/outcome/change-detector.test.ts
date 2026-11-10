import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { changeDetectorFor, workspaceChangeDetector } from './change-detector.js'

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): void {
	execFileSync('git', args, {
		cwd,
		stdio: 'ignore',
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 't',
			GIT_AUTHOR_EMAIL: 't@example.invalid',
			GIT_COMMITTER_NAME: 't',
			GIT_COMMITTER_EMAIL: 't@example.invalid',
			GIT_CONFIG_GLOBAL: '/dev/null',
			GIT_CONFIG_SYSTEM: '/dev/null',
		},
	})
}

function repository(): string {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-outcome-detector-'))
	dirs.push(dir)
	git(dir, 'init', '-q')
	writeFileSync(join(dir, 'a.txt'), 'one\n')
	git(dir, 'add', 'a.txt')
	git(dir, 'commit', '-q', '-m', 'first')
	return dir
}

describe('the change detector for a turn', () => {
	it('answers the same until the working tree moves, then differently', async () => {
		const dir = repository()
		const detect = workspaceChangeDetector(dir)
		const before = await detect()
		expect(typeof before).toBe('string')
		expect(await detect()).toBe(before)
		writeFileSync(join(dir, 'a.txt'), 'two\n')
		const after = await detect()
		expect(typeof after).toBe('string')
		expect(after).not.toBe(before)
		writeFileSync(join(dir, 'new.txt'), 'x\n')
		expect(await detect()).not.toBe(after)
	})

	it('cannot tell in a folder that is not a repository, and says so with null', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-outcome-detector-'))
		dirs.push(dir)
		expect(await workspaceChangeDetector(dir)()).toBeNull()
	})

	it('is none where the tools work in a copy of their own', () => {
		expect(changeDetectorFor('/work', { active: true, workspace: 'ephemeral' })).toBeUndefined()
		expect(changeDetectorFor('/work', { active: true, workspace: 'working-directory' })).toBeTypeOf(
			'function',
		)
		expect(changeDetectorFor('/work', { active: false, workspace: 'ephemeral' })).toBeTypeOf(
			'function',
		)
	})
})
