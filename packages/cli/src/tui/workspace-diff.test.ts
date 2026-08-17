import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { renderWorkspaceDiff, workspaceDiff } from './workspace-diff.js'

/**
 * `/diff` answers "what is uncommitted here", and the thing it must never do is
 * answer a different question quietly.
 *
 * Two failures it is written against. A directory that is not a repository
 * produces an empty diff from every naive implementation, and an empty diff
 * reads as "nothing changed" — the opposite of "I cannot tell". And `git diff`
 * shows no untracked file at all, so a session whose entire output is new files
 * would report that it changed nothing.
 *
 * Run against real repositories rather than a mocked git: what is under test is
 * an agreement with a program, and a mock is an agreement with my belief about
 * it.
 */

const dirs: string[] = []

afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

function repo(): string {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-diff-'))
	dirs.push(dir)
	const git = (...args: string[]): void => {
		execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
	}
	git('init', '-q')
	git('config', 'user.email', 'test@example.invalid')
	git('config', 'user.name', 'test')
	writeFileSync(join(dir, 'kept.txt'), 'original\n')
	git('add', '.')
	git('commit', '-qm', 'first')
	return dir
}

describe('workspaceDiff', () => {
	it('returns null outside a repository, so the caller can say "cannot tell"', async () => {
		// The load-bearing one. An empty result here would render as "working
		// tree clean", which is a claim about a repository that does not exist.
		const plain = mkdtempSync(join(tmpdir(), 'namzu-not-a-repo-'))
		dirs.push(plain)
		expect(await workspaceDiff(plain)).toBeNull()
	})

	it('reports a modified tracked file', async () => {
		const dir = repo()
		writeFileSync(join(dir, 'kept.txt'), 'changed\n')

		const diff = await workspaceDiff(dir)
		expect(diff).not.toBeNull()
		expect(diff?.stat).toContain('kept.txt')
		expect(diff?.patch).toContain('-original')
		expect(diff?.patch).toContain('+changed')
	})

	it('lists an untracked file, which no diff would show', async () => {
		const dir = repo()
		writeFileSync(join(dir, 'brand-new.txt'), 'hello\n')

		const diff = await workspaceDiff(dir)
		expect(diff?.untracked).toEqual(['brand-new.txt'])
		// And the patch genuinely does not mention it — which is the reason the
		// field exists rather than a quirk of this assertion.
		expect(diff?.patch).not.toContain('brand-new.txt')
	})

	it('is empty on both axes for a clean tree', async () => {
		const diff = await workspaceDiff(repo())
		expect(diff?.stat).toBe('')
		expect(diff?.untracked).toEqual([])
	})
})

describe('renderWorkspaceDiff', () => {
	it('says it cannot tell, rather than showing an empty diff', async () => {
		const plain = mkdtempSync(join(tmpdir(), 'namzu-not-a-repo-'))
		dirs.push(plain)
		const { summary } = renderWorkspaceDiff(await workspaceDiff(plain))
		expect(summary).toMatch(/Cannot read a diff/)
		expect(summary).not.toMatch(/clean/)
	})

	it('says the tree is clean when it is', async () => {
		const { summary, detail } = renderWorkspaceDiff(await workspaceDiff(repo()))
		expect(summary).toMatch(/clean/)
		expect(detail).toEqual([])
	})

	it('states that the answer covers the whole tree, not only the agent', async () => {
		// Printed on every non-empty answer. Without it an operator reads their
		// own uncommitted work as the agent's, which is the one misreading this
		// command can cause and cannot detect.
		const dir = repo()
		writeFileSync(join(dir, 'kept.txt'), 'changed\n')
		const { summary } = renderWorkspaceDiff(await workspaceDiff(dir))
		expect(summary).toMatch(/not only what the agent changed/)
	})

	it('puts the patch in the collapsible body, not the summary line', async () => {
		const dir = repo()
		writeFileSync(join(dir, 'kept.txt'), 'changed\n')
		const { summary, detail } = renderWorkspaceDiff(await workspaceDiff(dir))
		expect(detail.join('\n')).toContain('+changed')
		expect(summary).not.toContain('+changed')
	})

	it('names untracked files in the summary, where they cannot be missed', async () => {
		const dir = repo()
		writeFileSync(join(dir, 'brand-new.txt'), 'hello\n')
		const { summary } = renderWorkspaceDiff(await workspaceDiff(dir))
		expect(summary).toContain('brand-new.txt')
		expect(summary).toMatch(/Untracked/)
	})

	it('says when the patch was truncated rather than ending mid-hunk', async () => {
		const diff = {
			stat: ' f | 1 +',
			patch: 'a'.repeat(100),
			truncated: true,
			untracked: [],
		}
		const { detail } = renderWorkspaceDiff(diff)
		expect(detail.join('\n')).toMatch(/truncated/)
	})
})
