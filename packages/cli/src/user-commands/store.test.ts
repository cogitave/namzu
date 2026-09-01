import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'

import { discoverUserCommands, expandCommand } from './store.js'

let home: string
let cwd: string

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-uc-home-'))
	cwd = mkdtempSync(join(tmpdir(), 'namzu-uc-proj-'))
})

afterEach(() => {
	removeTempDir(home)
	removeTempDir(cwd)
})

function write(root: string, name: string, body: string): void {
	const dir = join(root, '.namzu', 'commands')
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, name), body)
}

describe('discoverUserCommands', () => {
	it('is empty when nothing is defined, which is the normal case', () => {
		expect(discoverUserCommands({ home, cwd })).toEqual([])
	})

	it('reads a bare template with no frontmatter', () => {
		write(cwd, 'review.md', 'Review the diff for correctness.')
		const [cmd] = discoverUserCommands({ home, cwd })
		expect(cmd?.name).toBe('review')
		expect(cmd?.template).toBe('Review the diff for correctness.')
		expect(cmd?.problem).toBeUndefined()
	})

	it('takes the description from frontmatter, CRLF included', () => {
		// Same reader as skills, so the Windows line-ending fix comes with it
		// rather than needing to be remembered here.
		write(cwd, 'ship.md', '---\r\ndescription: Cut a release\r\n---\r\nDo the release.')
		const [cmd] = discoverUserCommands({ home, cwd })
		expect(cmd?.description).toBe('Cut a release')
		expect(cmd?.template).toBe('Do the release.')
	})

	it('lets a project command shadow a user one', () => {
		write(home, 'review.md', 'user version')
		write(cwd, 'review.md', 'project version')
		const found = discoverUserCommands({ home, cwd })
		expect(found).toHaveLength(1)
		expect(found[0]?.template).toBe('project version')
		expect(found[0]?.source).toBe('project')
	})

	it('keeps commands under the home directory in user scope when home is the cwd', () => {
		write(home, 'review.md', 'user version')

		const found = discoverUserCommands({ home, cwd: home })

		expect(found).toHaveLength(1)
		expect(found[0]?.template).toBe('user version')
		expect(found[0]?.source).toBe('user')
	})

	it('refuses a broken file without losing the others', () => {
		// The `SkillInfo.problem` pattern: one bad file must not empty the list,
		// and its author has to be told why it never ran.
		write(cwd, 'good.md', 'fine')
		write(cwd, 'broken.md', '---\nunclosed frontmatter')
		const found = discoverUserCommands({ home, cwd })

		expect(found.map((c) => c.name)).toEqual(['broken', 'good'])
		expect(found.find((c) => c.name === 'good')?.problem).toBeUndefined()
		expect(found.find((c) => c.name === 'broken')?.problem).toMatch(/unclosed/i)
	})

	it('names the file in the refusal', () => {
		write(cwd, 'broken.md', '---\nunclosed')
		const found = discoverUserCommands({ home, cwd })
		expect(found[0]?.problem).toContain('broken.md')
	})

	it('will not let a file take a built-in name', () => {
		// A builtin someone relies on disappearing because a file appeared is the
		// worst kind of surprise; ignoring the file silently is the second worst.
		write(cwd, 'help.md', 'not the real help')
		const [cmd] = discoverUserCommands({ home, cwd, reserved: ['help'] })
		expect(cmd?.problem).toContain('built-in')
	})

	it('ignores files that are not markdown', () => {
		write(cwd, 'notes.txt', 'not a command')
		expect(discoverUserCommands({ home, cwd })).toEqual([])
	})
})

describe('expandCommand', () => {
	const cmd = (template: string) =>
		({
			name: 'demo',
			description: '',
			template,
			path: '/p/demo.md',
			source: 'project',
		}) as const

	it('substitutes $ARGUMENTS', () => {
		const r = expandCommand(cmd('Review $ARGUMENTS please'), 'src/foo.ts')
		expect(r.ok && r.prompt).toBe('Review src/foo.ts please')
	})

	it('substitutes every occurrence', () => {
		const r = expandCommand(cmd('$ARGUMENTS then $ARGUMENTS'), 'x')
		expect(r.ok && r.prompt).toBe('x then x')
	})

	it('substitutes empty when no arguments were given', () => {
		const r = expandCommand(cmd('Review $ARGUMENTS'), '')
		expect(r.ok && r.prompt).toBe('Review ')
	})

	it('runs a static template with no arguments', () => {
		const r = expandCommand(cmd('Summarise the diff.'), '')
		expect(r.ok && r.prompt).toBe('Summarise the diff.')
	})

	it('REFUSES arguments a template cannot receive, rather than dropping them', () => {
		// The contract decision. Silently discarding what the operator typed is
		// the failure mode this whole file is written against; appending them
		// somewhere would be guessing where the author wanted them.
		const r = expandCommand(cmd('Summarise the diff.'), 'src/foo.ts')
		expect(r.ok).toBe(false)
		expect(!r.ok && r.reason).toContain('takes no arguments')
	})

	it('names the file and the exact fix when it refuses', () => {
		const r = expandCommand(cmd('static'), 'oops')
		expect(!r.ok && r.reason).toContain('$ARGUMENTS')
		expect(!r.ok && r.reason).toContain('/p/demo.md')
	})

	it('refuses a command that could not be read', () => {
		const broken = { ...cmd(''), problem: 'bad frontmatter' }
		const r = expandCommand(broken, '')
		expect(r.ok).toBe(false)
		expect(!r.ok && r.reason).toBe('bad frontmatter')
	})
})
