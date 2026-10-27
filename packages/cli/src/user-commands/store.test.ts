import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'

import { discoverUserCommands, expandCommand, expandHeadlessCommand } from './store.js'

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
		expect(!r.ok && r.reason).toContain('does not take extra text')
	})

	it('names the file and the way out in plain words, without the placeholder or the path', () => {
		const r = expandCommand(cmd('static'), 'oops')
		const reason = !r.ok ? r.reason : ''
		expect(reason).toContain('“oops” was not used')
		expect(reason).toContain('Run /demo on its own, or edit demo.md')
		expect(reason).not.toContain('$ARGUMENTS')
		expect(reason).not.toContain('/p/')
	})

	it('names a skill by its folder, since every skill file is called SKILL.md', () => {
		const r = expandCommand(
			{ ...cmd('static'), path: '/home/a/.namzu/skills/review/SKILL.md' },
			'x',
		)
		expect(!r.ok && r.reason).toContain('edit review/SKILL.md')
	})

	it('refuses a command that could not be read', () => {
		const broken = { ...cmd(''), problem: 'bad frontmatter' }
		const r = expandCommand(broken, '')
		expect(r.ok).toBe(false)
		expect(!r.ok && r.reason).toBe('bad frontmatter')
	})
})

describe('skills as commands', () => {
	function skill(root: string, name: string, frontmatter: string, body: string): void {
		const dir = join(root, '.namzu', 'skills', name)
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\n${frontmatter}\n---\n${body}`)
	}
	const withSkills = () => discoverUserCommands({ home, cwd, skillCommands: 'declared' })

	it('leaves skills out unless asked', () => {
		skill(cwd, 'triage', 'description: Triage a bug', 'Look at $ARGUMENTS.')
		expect(discoverUserCommands({ home, cwd })).toEqual([])
	})

	it('makes an invocable skill /<name>, its body the template, with the argument hint', () => {
		skill(
			cwd,
			'triage',
			'description: Triage a bug\nargument-hint: [issue-number]',
			'Look at $ARGUMENTS.',
		)
		const cmd = withSkills().find((c) => c.name === 'triage')
		expect(cmd?.source).toBe('skill')
		expect(cmd?.description).toBe('Triage a bug')
		expect(cmd?.argumentHint).toBe('[issue-number]')
		const expanded = expandCommand(cmd as NonNullable<typeof cmd>, '42')
		expect(expanded).toMatchObject({ ok: true })
		expect(expanded.ok && expanded.prompt).toContain('Look at 42.')
		expect(expanded.ok && expanded.prompt).toContain('Base directory for this skill:')
	})

	it('refuses arguments a skill body has no place for, like any command', () => {
		skill(cwd, 'tidy', 'description: Tidy up', 'Tidy the repo.')
		const cmd = withSkills().find((c) => c.name === 'tidy')
		const expanded = expandCommand(cmd as NonNullable<typeof cmd>, 'now')
		expect(expanded.ok).toBe(false)
		expect(expandCommand(cmd as NonNullable<typeof cmd>, '').ok).toBe(true)
	})

	it('gives no command to a model-only skill or one hidden from the person', () => {
		skill(cwd, 'model-only', 'description: x\ninvocation: model', 'body')
		skill(cwd, 'hidden', 'description: x\nuser-invocable: false', 'body')
		skill(cwd, 'person-only', 'description: x\ndisable-model-invocation: true', 'body')
		expect(withSkills().map((c) => c.name)).toEqual(['person-only'])
	})

	it('lets a command file shadow a skill of the same name', () => {
		skill(cwd, 'review', 'description: from the skill', 'skill body')
		write(cwd, 'review.md', 'command body')
		const found = withSkills().filter((c) => c.name === 'review')
		expect(found).toHaveLength(1)
		expect(found[0]?.source).toBe('project')
	})

	it('keeps the skills that ship with Namzu out of a headless prompt but offers them to the terminal', () => {
		const declared = discoverUserCommands({ home, cwd, skillCommands: 'declared' })
		const all = discoverUserCommands({ home, cwd, skillCommands: 'all' })
		expect(declared.map((c) => c.name)).not.toContain('skill-creator')
		expect(all.map((c) => c.name)).toContain('skill-creator')
	})

	it('reads an argument hint in a command file too', () => {
		write(cwd, 'fix.md', '---\ndescription: Fix it\nargument-hint: [file]\n---\nFix $ARGUMENTS')
		const [cmd] = discoverUserCommands({ home, cwd })
		expect(cmd?.argumentHint).toBe('[file]')
	})

	it('expands a skill the project declared in a headless prompt, and leaves a shipped one as prose', () => {
		skill(cwd, 'triage', 'description: Triage', 'Look at $ARGUMENTS.')
		const declared = expandHeadlessCommand('/triage 42', { home, cwd })
		expect(declared.kind).toBe('expanded')
		expect(declared.kind === 'expanded' && declared.prompt).toContain('Look at 42.')
		expect(expandHeadlessCommand('/skill-creator draft one', { home, cwd }).kind).toBe('unchanged')
	})
})
