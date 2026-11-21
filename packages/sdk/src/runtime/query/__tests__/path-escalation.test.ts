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

	it('reads a path under a link made earlier in the same line as outside', async () => {
		const through = await reach('ln -s /etc l && cd l && echo x > passwd')
		expect(through.outsidePaths).not.toEqual([])
		const direct = await reach('ln -s /etc l && echo x > l/passwd')
		expect(direct.outsidePaths).not.toEqual([])
		// A line that makes no link keeps its meaning.
		expect((await reach('cd src && echo x > passwd')).outsidePaths).toEqual([])
	})

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

	it('follows a literal cd to a directory inside the roots for a later relative write', async () => {
		expect((await reach('cd src && echo x > out.txt')).outsidePaths).toEqual([])
		expect((await reach('cd src && touch a.txt')).outsidePaths).toEqual([])
		expect((await reach('cd src && cd . && touch a.txt')).outsidePaths).toEqual([])
		expect((await reach('cd src && cat a.txt')).outsidePaths).toEqual([])
	})

	it('still flags a write after a cd it cannot follow', async () => {
		expect((await reach('cd "$DIR" && touch a.txt')).outsidePaths).toContain('a.txt')
		expect((await reach('cd /elsewhere && echo x > f')).outsidePaths).toContain('f')
		expect((await reach('cd ~ && touch a.txt')).outsidePaths).toContain('a.txt')
		expect((await reach('pushd src && touch a.txt')).outsidePaths).toContain('a.txt')
		expect((await reach('cd - && touch a.txt')).outsidePaths).toContain('a.txt')
	})

	it('still flags a cd that leaves the roots, and a write that climbs out after one inside', async () => {
		expect((await reach('cd .. && touch a.txt')).outsidePaths.length).toBeGreaterThan(0)
		expect((await reach('cd src && echo x > ../../out.txt')).outsidePaths.length).toBeGreaterThan(0)
	})

	it('judges a write before the cd by where the line began', async () => {
		expect((await reach('echo x > out.txt && cd src')).outsidePaths).toEqual([])
		expect((await reach('echo x > ../out.txt && cd src')).outsidePaths.length).toBe(1)
	})

	it('reads the protected name through the directory a cd moved to', async () => {
		const found = await reach('cd .git && echo x > config')
		expect(found.protectedPaths).toContain(join(worktree, '.git', 'config'))
	})

	it('does not trust a redirection it cannot tie to a command once a cd is in the line', async () => {
		expect((await reach('cd src; { echo x; } > out.txt')).outsidePaths).toContain('out.txt')
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

describe('a shell write into the session scratch folder', () => {
	const scratch = join(base, 'scratch')
	mkdirSync(scratch, { recursive: true })
	const reach = (line: string, scratchpadDirectory: string | null = scratch) =>
		shellEscalations(line, 'bash', {
			roots: scratchpadDirectory === null ? [worktree] : [worktree, scratchpadDirectory],
			reviewOutside: true,
			...(scratchpadDirectory !== null ? { scratchpadDirectory } : {}),
		})

	it('does not ask for a target named through $NAMZU_SCRATCH or by its literal path', async () => {
		expect((await reach('printf a > $NAMZU_SCRATCH/out.csv')).outsidePaths).toEqual([])
		expect((await reach('printf a > "${NAMZU_SCRATCH}/out.csv"')).outsidePaths).toEqual([])
		expect((await reach(`printf a > ${scratch}/out.csv`)).outsidePaths).toEqual([])
		expect((await reach('cp x.txt $NAMZU_SCRATCH/x.txt')).outsidePaths).toEqual([])
	})

	it('still asks for anything else outside the roots', async () => {
		expect((await reach('printf a > /etc/namzu-test')).outsidePaths).toEqual(['/etc/namzu-test'])
		expect((await reach('printf a > $NAMZU_SCRATCH/../../etc/x')).outsidePaths).not.toEqual([])
		expect((await reach('printf a > $NAMZU_SCRATCH/$X')).outsidePaths).not.toEqual([])
		expect((await reach('printf a > $OTHER/out.csv')).outsidePaths).not.toEqual([])
	})

	it('asks when the line changes the variable, or when there is no scratch folder', async () => {
		expect(
			(await reach('NAMZU_SCRATCH=/etc; printf a > $NAMZU_SCRATCH/x')).outsidePaths,
		).not.toEqual([])
		expect((await reach('printf a > $NAMZU_SCRATCH/x', null)).outsidePaths).not.toEqual([])
	})
})
