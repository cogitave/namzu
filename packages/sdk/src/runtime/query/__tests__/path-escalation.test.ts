import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { declaredWriteEscalation, expandBraces, shellEscalations } from '../path-escalation.js'

const base = mkdtempSync(join(tmpdir(), 'namzu-path-escalation-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

// A managed worktree lies under `.namzu` by construction.
const worktree = join(base, '.namzu', 'projects', 'p', 'worktrees', 'w')
const elsewhere = join(base, 'elsewhere')
mkdirSync(join(worktree, 'src'), { recursive: true })
mkdirSync(join(worktree, '.git', 'hooks'), { recursive: true })
mkdirSync(elsewhere, { recursive: true })

describe('what a declared write path reaches', () => {
	it('asks about a protected name below the root', async () => {
		expect(await declaredWriteEscalation([worktree], '.git/hooks/pre-commit')).toBe(
			join(worktree, '.git', 'hooks', 'pre-commit'),
		)
	})

	it('does not ask about every file in a root that itself sits under .namzu', async () => {
		expect(await declaredWriteEscalation([worktree], 'src/a.ts')).toBeUndefined()
		expect(await declaredWriteEscalation([worktree], join(worktree, 'src', 'a.ts'))).toBeUndefined()
	})

	it('asks about .namzu itself when it lies in no root', async () => {
		expect(await declaredWriteEscalation([elsewhere], join(base, '.namzu', 'config.yaml'))).toBe(
			join(base, '.namzu', 'config.yaml'),
		)
	})

	it('follows a link: a plain name that leads into a protected directory is protected', async () => {
		symlinkSync(join(worktree, '.git'), join(elsewhere, 'innocent'))
		expect(await declaredWriteEscalation([elsewhere], 'innocent/hooks/post-commit')).toBeDefined()
	})
})

describe('what a shell line reaches', () => {
	const reach = (line: string, roots: readonly string[] = [worktree], reviewOutside = true) =>
		shellEscalations(line, 'bash', { roots, reviewOutside })

	it('finds a redirection into a protected path and one outside the roots', async () => {
		const found = await reach('echo x > .git/hooks/post-commit; echo y > /etc/namzu-test')
		expect(found.protectedPaths).toEqual([join(worktree, '.git', 'hooks', 'post-commit')])
		expect(found.outsidePaths).toEqual(['/etc/namzu-test'])
	})

	it('reads ~ as the home directory for both questions', async () => {
		const found = await reach('cat ~/.ssh/id_ed25519; touch ~/.bashrc')
		expect(found.protectedPaths.length).toBe(1)
		expect(found.outsidePaths.length).toBe(2)
	})

	it('reports nothing outside the roots when the turn does not review them, but still the floors', async () => {
		const found = await reach('cat /etc/hosts; touch .envrc; rm -rf "$X/"', [worktree], false)
		expect(found.outsidePaths).toEqual([])
		expect(found.protectedPaths).toEqual([join(worktree, '.envrc')])
		expect(found.dangerousRemoval).toMatch(/\$X is empty/)
	})

	it('names a write decided at runtime as spelled, and leaves a read of one alone', async () => {
		expect((await reach('echo x > "$OUT"')).outsidePaths).toEqual(['$OUT'])
		expect((await reach('cat "$IN"')).outsidePaths).toEqual([])
	})

	it('treats a relative write after a cd as one it cannot place', async () => {
		expect((await reach('cd sub && touch a.txt')).outsidePaths).toContain('a.txt')
		expect((await reach('cd sub && cat a.txt')).outsidePaths).not.toContain('a.txt')
	})

	it('checks a glob at its directory', async () => {
		expect((await reach('cat /etc/*.conf')).outsidePaths).toEqual(['/etc'])
		expect((await reach('cat src/*.ts')).outsidePaths).toEqual([])
	})

	it('expands a brace list so a protected name inside it is seen', async () => {
		const found = await reach('cp payload {.bashrc,.zshrc}')
		expect(found.protectedPaths).toEqual([join(worktree, '.bashrc'), join(worktree, '.zshrc')])
	})

	it('leaves an ordinary line alone', async () => {
		expect(await reach('cat src/a.ts; ls .; echo x > src/out.txt')).toEqual({
			outsidePaths: [],
			protectedPaths: [],
		})
	})

	it('counts an added directory as a root', async () => {
		const found = await reach(`cat ${elsewhere}/x.txt`, [worktree, elsewhere])
		expect(found.outsidePaths).toEqual([])
	})
})

describe('expandBraces', () => {
	it('expands comma lists and leaves the rest', () => {
		expect(expandBraces('a{b,c}d')).toEqual(['abd', 'acd'])
		expect(expandBraces('{a,b}{1,2}')).toEqual(['a1', 'a2', 'b1', 'b2'])
		expect(expandBraces('{a}')).toEqual(['{a}'])
		expect(expandBraces('plain')).toEqual(['plain'])
	})

	it('is bounded', () => {
		expect(expandBraces('{1,2,3,4}{1,2,3,4}{1,2,3,4}').length).toBeLessThanOrEqual(16)
	})
})
