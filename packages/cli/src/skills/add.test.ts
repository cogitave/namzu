import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { makeZip } from '../integrations/extensions/__fixtures__/package-builder.js'
import {
	type InstallContext,
	MD_YAML_MESSAGE,
	SKILL_FILE_MAX_BYTES,
	SkillInputError,
	TOO_LARGE_MESSAGE,
	WRONG_EXTENSION_MESSAGE,
	addSkillInput,
	readSkillInput,
	setFrontmatterName,
} from './add.js'
import { createSkill, startsWithFrontmatter } from './create.js'
import { type InstallFsOps, SKILL_INSTALL_RECORD } from './install.js'
import { removeSkill } from './remove.js'
import { discoverSkillRoster } from './store.js'

let root: string
let home: string
let cwd: string
let inputs: string

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-skill-add-'))
	home = join(root, 'home')
	cwd = join(root, 'proj')
	inputs = join(root, 'in')
	for (const d of [home, cwd, inputs]) mkdirSync(d, { recursive: true })
})
afterEach(() => removeTempDir(root))

const userDir = () => join(home, '.namzu', 'skills')
const projectDir = () => join(cwd, '.namzu', 'skills')
const backups = () => join(home, '.namzu', 'backups', 'skills')
const NOW = new Date('2026-11-27T10:00:00.000Z')

const md = (
	name: string | undefined,
	description = 'Does a thing. Use when asked.',
	body = 'Do the thing.',
	extra = '',
): string =>
	[
		'---',
		...(name === undefined ? [] : [`name: ${name}`]),
		`description: ${description}`,
		...(extra === '' ? [] : [extra]),
		'---',
		'',
		body,
		'',
	].join('\n')

const ctx = (over: Partial<InstallContext> = {}): InstallContext => ({
	scope: 'user',
	cwd,
	home,
	yes: false,
	replace: false,
	now: () => NOW,
	...over,
})
const put = (name: string, text: string | Buffer): string => {
	const path = join(inputs, name)
	mkdirSync(join(path, '..'), { recursive: true })
	writeFileSync(path, text)
	return path
}
const zip = (name: string, entries: Parameters<typeof makeZip>[0]): string =>
	put(name, makeZip(entries))
const file = (path: string, text: string) => ({ name: path, data: Buffer.from(text) })
const reason = (fn: () => unknown): SkillInputError => {
	try {
		fn()
	} catch (error) {
		if (error instanceof SkillInputError) return error
		throw error
	}
	throw new Error('did not throw')
}

describe('reading an input', () => {
	it('wraps a .md as SKILL.md and takes its name from the frontmatter', () => {
		const p = readSkillInput(put('anything.md', md('weekly-report')))
		expect(p.name).toBe('weekly-report')
		expect([...p.files.keys()]).toEqual(['SKILL.md'])
		expect(p.findings).toEqual([])
	})

	it('needs name and description in YAML for a .md', () => {
		expect(reason(() => readSkillInput(put('a.md', 'just text, no frontmatter'))).message).toBe(
			MD_YAML_MESSAGE,
		)
		expect(reason(() => readSkillInput(put('b.md', '---\nname: b\n---\nbody'))).message).toBe(
			MD_YAML_MESSAGE,
		)
	})

	it('names a .md without a frontmatter name from the file, and suggests a name when that is not valid', () => {
		expect(readSkillInput(put('daily-note.md', md(undefined))).name).toBe('daily-note')
		const error = reason(() => readSkillInput(put('Weekly Status.md', md(undefined))))
		expect(error.message).toContain('Try "weekly-status"')
		expect(error.message).toContain('--name weekly-status')
		expect(
			readSkillInput(put('Weekly Status.md', md(undefined)), { name: 'weekly-status' }).name,
		).toBe('weekly-status')
	})

	it('rewrites the name when --name differs from the file', () => {
		const p = readSkillInput(put('x.md', md('old-name')), { name: 'new-name' })
		expect(p.markdown).toContain('name: new-name')
		expect(p.markdown).not.toContain('old-name')
		expect(p.findings.join(' ')).toContain('(--name)')
	})

	it('adds a name line when the frontmatter has none', () => {
		expect(setFrontmatterName('---\ndescription: d\n---\nb', 'n')).toBe(
			'---\nname: n\ndescription: d\n---\nb',
		)
		expect(setFrontmatterName('---\r\nname: o\r\ndescription: d\r\n---\r\nb', 'n')).toBe(
			'---\r\nname: n\r\ndescription: d\r\n---\r\nb',
		)
	})

	it('refuses a name, description or body that breaks the shared rules', () => {
		expect(reason(() => readSkillInput(put('a.md', md('Bad Name')))).message).toContain(
			'cannot be used',
		)
		expect(reason(() => readSkillInput(put('b.md', md('b', 'x'.repeat(1025))))).message).toContain(
			'at most 1024',
		)
		expect(
			reason(() => readSkillInput(put('c.md', md('c', 'use <script> here')))).message,
		).toContain('tags')
		expect(reason(() => readSkillInput(put('d.md', md('d', 'ok', '   ')))).message).toContain(
			'no instructions',
		)
		expect(
			reason(() => readSkillInput(put('e.md', md('e', 'ok', 'x'.repeat(70_000))))).message,
		).toContain('at most 65536')
	})

	it('reports keys it does not read and keeps them', () => {
		const p = readSkillInput(put('a.md', md('a', 'd', 'body', 'author: someone\nversion: 3')))
		expect(p.findings.join(' ')).toContain('author, version')
		expect(p.markdown).toContain('author: someone')
	})

	it('accepts only .zip, .skill and .md files, and at most 30 MB', () => {
		expect(reason(() => readSkillInput(put('a.txt', 'x'))).message).toBe(WRONG_EXTENSION_MESSAGE)
		expect(reason(() => readSkillInput(join(inputs, 'missing.zip'))).message).toContain(
			'does not exist',
		)
		const big = join(inputs, 'big.md')
		writeFileSync(big, Buffer.alloc(SKILL_FILE_MAX_BYTES + 1))
		expect(reason(() => readSkillInput(big)).message).toBe(TOO_LARGE_MESSAGE)
		expect(TOO_LARGE_MESSAGE).toBe('Skill file is too large. Maximum size is 30 MB.')
	})

	it('reads a zip with SKILL.md at its root, in any letter case', () => {
		const p = readSkillInput(
			zip('s.skill', [file('skill.md', md('from-zip')), file('references/api.md', 'ref')]),
		)
		expect(p.name).toBe('from-zip')
		expect([...p.files.keys()].sort()).toEqual(['SKILL.md', 'references/api.md'])
	})

	it('reads a zip with one wrapping folder, names it from the folder, and leaves outside files out', () => {
		const p = readSkillInput(
			zip('s.zip', [
				file('my-skill/SKILL.md', md(undefined)),
				file('my-skill/data/x.txt', 'x'),
				file('README.txt', 'outside'),
				file('__MACOSX/._x', 'junk'),
				file('.DS_Store', 'junk'),
			]),
		)
		expect(p.name).toBe('my-skill')
		expect([...p.files.keys()].sort()).toEqual(['SKILL.md', 'data/x.txt'])
		expect(p.findings.join(' ')).toContain('1 file outside the folder')
	})

	it('refuses a zip with two SKILL.md as a bundle, and one with none', () => {
		const bundle = reason(() =>
			readSkillInput(zip('b.zip', [file('a/SKILL.md', md('a')), file('b/SKILL.md', md('b'))])),
		)
		expect(bundle.message).toBe(
			'This file holds 2 skills. Add them one at a time, or install it as a plugin.',
		)
		expect(reason(() => readSkillInput(zip('n.zip', [file('x.txt', 'x')]))).message).toBe(
			'A .zip or .skill file must include a SKILL.md file.',
		)
		expect(
			reason(() => readSkillInput(zip('d.zip', [file('a/b/SKILL.md', md('a'))]))).message,
		).toContain('top, or inside one folder')
	})

	it('refuses a zip with a link entry as unsafe, and writes nothing', () => {
		const error = reason(() =>
			readSkillInput(
				zip('l.zip', [
					file('SKILL.md', md('l')),
					{ name: 'x', data: Buffer.from('/etc/passwd'), mode: 0o120777 },
				]),
			),
		)
		expect(error.kind).toBe('refused')
		expect(error.message).toContain('link')
		for (const bad of ['../evil', '/abs', 'a\\b']) {
			expect(
				reason(() => readSkillInput(zip('s.zip', [file('SKILL.md', md('s')), file(bad, 'x')])))
					.kind,
			).toBe('refused')
		}
	})

	it('refuses a zip over the skill entry cap', () => {
		const entries = [file('SKILL.md', md('many'))]
		for (let i = 0; i < 500; i++) entries.push(file(`f/${i}.txt`, 'x'))
		const error = reason(() => readSkillInput(zip('m.zip', entries)))
		expect(error.kind).toBe('refused')
		expect(error.message).toContain('at most 500')
	})

	it('treats a file that is not a zip as a failure, not as unsafe', () => {
		expect(reason(() => readSkillInput(put('bad.zip', 'not a zip at all, really'))).kind).toBe(
			'failed',
		)
	})

	it('keeps the execute bit only under scripts/ and says so', () => {
		const p = readSkillInput(
			zip('x.zip', [
				file('SKILL.md', md('x')),
				{ name: 'scripts/run.sh', data: Buffer.from('#!/bin/sh'), mode: 0o100755 },
				{ name: 'tools/other.sh', data: Buffer.from('#!/bin/sh'), mode: 0o104755 },
			]),
		)
		expect(p.files.get('scripts/run.sh')?.executable).toBe(true)
		expect(p.files.get('tools/other.sh')?.executable).toBe(false)
		expect(p.findings.join(' ')).toContain('tools/other.sh had an execute bit')
		expect(p.consent.join(' ')).toContain('Ships scripts: scripts/run.sh')
	})

	it('reads a folder, and refuses a link inside it', () => {
		const dir = join(inputs, 'folder-skill')
		mkdirSync(join(dir, 'references'), { recursive: true })
		writeFileSync(join(dir, 'SKILL.md'), md(undefined))
		writeFileSync(join(dir, 'references', 'a.md'), 'a')
		const p = readSkillInput(dir)
		expect(p.name).toBe('folder-skill')
		expect(p.source).toBe('folder')
		expect(p.files.size).toBe(2)
		symlinkSync('/etc/hostname', join(dir, 'link'))
		const error = reason(() => readSkillInput(dir))
		expect(error.kind).toBe('refused')
		expect(error.message).toContain('link')
	})

	it('derives consent from commands, hooks and pre-approved shell tools', () => {
		const inline = readSkillInput(put('i.md', md('i', 'd', 'Status: !`git status`')))
		expect(inline.consent.join(' ')).toContain('Runs commands: git status')
		const tools = readSkillInput(
			put('t.md', md('t', 'd', 'body', 'allowed-tools: Bash(git log:*) Read')),
		)
		expect(tools.consent).toEqual(['Pre-approves while this skill runs: Bash(git log:*)'])
		const plain = readSkillInput(put('p.md', md('p', 'd', 'body', 'allowed-tools: Read')))
		expect(plain.consent).toEqual([])
		const hooks = readSkillInput(
			put(
				'h.md',
				'---\nname: h\ndescription: d\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: ./guard.sh\n---\nbody\n',
			),
		)
		expect(hooks.consent.join(' ')).toContain('guard.sh')
	})
})

describe('adding', () => {
	it('adds a plain skill without asking, with provenance the reader ignores', async () => {
		const outcome = await addSkillInput(put('a.md', md('weekly-report')), {}, ctx())
		expect(outcome.status).toBe('added')
		expect(outcome.message).toBe(
			'Added skill "weekly-report" to your skills (1 file). It is available from your next message.',
		)
		const dir = join(userDir(), 'weekly-report')
		const record = JSON.parse(readFileSync(join(dir, SKILL_INSTALL_RECORD), 'utf8'))
		expect(record).toMatchObject({
			version: 1,
			source: 'file',
			fileName: 'a.md',
			installedAt: NOW.toISOString(),
		})
		expect(record.sha256).toMatch(/^[0-9a-f]{64}$/)
		const roster = discoverSkillRoster({ home, cwd, config: { builtin: false } })
		expect(roster.skills.map((s) => [s.name, s.problem])).toEqual([['weekly-report', undefined]])
		expect(existsSync(join(userDir(), '.staging'))).toBe(false)
	})

	it('counts the files of a zip and installs the execute bit under scripts/ only', async () => {
		const path = zip('r.zip', [
			file('SKILL.md', md('with-scripts')),
			{ name: 'scripts/run.sh', data: Buffer.from('#!/bin/sh\n'), mode: 0o100755 },
			file('notes.txt', 'n'),
		])
		const outcome = await addSkillInput(path, {}, ctx({ yes: true }))
		expect(outcome.status).toBe('added')
		expect(outcome.message).toContain('(3 files)')
		const dir = join(userDir(), 'with-scripts')
		expect(lstatSync(join(dir, 'scripts', 'run.sh')).mode & 0o111).not.toBe(0)
		expect(lstatSync(join(dir, 'notes.txt')).mode & 0o111).toBe(0)
	})

	it('adds to the project folder with the project wording', async () => {
		const outcome = await addSkillInput(
			put('p.md', md('proj-skill')),
			{},
			ctx({ scope: 'project' }),
		)
		expect(outcome.status).toBe('added')
		expect(outcome.message).toContain("this project's skills")
		expect(existsSync(join(projectDir(), 'proj-skill', 'SKILL.md'))).toBe(true)
	})

	it('refuses the name of a built-in skill', async () => {
		const builtin = discoverSkillRoster({ home, cwd }).skills.find((s) => s.tier === 'system')
		expect(builtin).toBeDefined()
		const outcome = await addSkillInput(put('b.md', md(builtin?.name)), {}, ctx())
		expect(outcome.status).toBe('failed')
		expect(outcome.message).toBe(
			`"${builtin?.name}" is the name of a built-in skill, so it cannot be used.`,
		)
		expect(existsSync(join(userDir(), builtin?.name ?? ''))).toBe(false)
	})

	it('asks before a skill that can run commands, and writes nothing when nobody can be asked', async () => {
		const path = put('c.md', md('runs-things', 'd', 'Now: !`date`'))
		const none = await addSkillInput(path, {}, ctx())
		expect(none.status).toBe('needs-consent')
		expect(none.preview?.join(' ')).toContain('Runs commands: date')
		expect(none.message).toContain('--yes')
		expect(existsSync(join(userDir(), 'runs-things'))).toBe(false)

		const asked: string[][] = []
		const no = await addSkillInput(
			path,
			{},
			ctx({
				ask: async (_q, p) => {
					asked.push([...p])
					return false
				},
			}),
		)
		expect(no.status).toBe('declined')
		expect(asked[0]?.join(' ')).toContain('date')
		expect(existsSync(join(userDir(), 'runs-things'))).toBe(false)

		const yes = await addSkillInput(path, {}, ctx({ ask: async () => true }))
		expect(yes.status).toBe('added')
		expect(
			(await addSkillInput(put('d.md', md('runs-two', 'd', '!`ls`')), {}, ctx({ yes: true })))
				.status,
		).toBe('added')
	})

	it('does not ask about a plain skill even when a terminal exists', async () => {
		let asked = 0
		const outcome = await addSkillInput(
			put('e.md', md('plain-one')),
			{},
			ctx({
				ask: async () => {
					asked++
					return true
				},
			}),
		)
		expect(outcome.status).toBe('added')
		expect(asked).toBe(0)
	})

	it('needs --replace or a yes for a skill of the same name, and keeps the old folder in backups', async () => {
		await addSkillInput(put('v1.md', md('same', 'first')), {}, ctx())
		const second = put('v2.md', md('same', 'second'))
		const refused = await addSkillInput(second, {}, ctx())
		expect(refused.status).toBe('needs-consent')
		expect(refused.message).toContain('--replace')
		expect(readFileSync(join(userDir(), 'same', 'SKILL.md'), 'utf8')).toContain('first')

		const replaced = await addSkillInput(second, {}, ctx({ replace: true }))
		expect(replaced.status).toBe('replaced')
		expect(readFileSync(join(userDir(), 'same', 'SKILL.md'), 'utf8')).toContain('second')
		const kept = readdirSync(backups())
		expect(kept).toEqual([`same.${NOW.getTime()}`])
		expect(readFileSync(join(backups(), kept[0] as string, 'SKILL.md'), 'utf8')).toContain('first')
		expect(replaced.backup).toBe(join(backups(), kept[0] as string))
	})

	it('reports the other tiers with the planner save_skill uses', async () => {
		await addSkillInput(put('u.md', md('both-tiers', 'user one')), {}, ctx())
		const outcome = await addSkillInput(
			put('p.md', md('both-tiers', 'project one')),
			{},
			ctx({ scope: 'project' }),
		)
		expect(outcome.status).toBe('added')
		expect(outcome.notes.join(' ')).toContain('replaces user skill')
		const reverse = await addSkillInput(
			put('u2.md', md('both-tiers', 'user two')),
			{},
			ctx({ replace: true }),
		)
		expect(reverse.notes.join(' ')).toContain('hidden by project skill')
	})

	it('refuses a target folder that is a link, and writes nothing through it', async () => {
		const elsewhere = join(root, 'elsewhere')
		mkdirSync(elsewhere)
		mkdirSync(userDir(), { recursive: true })
		symlinkSync(elsewhere, join(userDir(), 'linked'))
		const outcome = await addSkillInput(
			put('l.md', md('linked')),
			{},
			ctx({ replace: true, yes: true }),
		)
		expect(outcome.status).toBe('refused')
		expect(readdirSync(elsewhere)).toEqual([])
	})

	it('refuses a project .namzu that is a link', async () => {
		const elsewhere = join(root, 'out')
		mkdirSync(elsewhere)
		symlinkSync(elsewhere, join(cwd, '.namzu'))
		const outcome = await addSkillInput(put('m.md', md('via-link')), {}, ctx({ scope: 'project' }))
		expect(outcome.status).toBe('refused')
		expect(readdirSync(elsewhere)).toEqual([])
	})

	it('names each independent input and lets a failure leave the others alone', async () => {
		const good = await addSkillInput(put('ok.md', md('ok-one')), {}, ctx())
		const bad = await addSkillInput(put('bad.md', 'no frontmatter'), {}, ctx())
		expect([good.status, bad.status]).toEqual(['added', 'failed'])
		expect(bad.input).toBe(join(inputs, 'bad.md'))
	})
})

describe('crash safety of a replacement', () => {
	const failing = (failOn: number[]): InstallFsOps & { calls: number } => {
		const ops = {
			calls: 0,
			rename(from: string, to: string) {
				ops.calls++
				if (failOn.includes(ops.calls))
					throw Object.assign(new Error(`injected failure ${ops.calls}`), { code: 'EIO' })
				renameSync(from, to)
			},
		}
		return ops
	}

	async function seeded() {
		await addSkillInput(put('old.md', md('victim', 'old')), {}, ctx())
		return put('new.md', md('victim', 'new'))
	}
	const target = () => join(userDir(), 'victim', 'SKILL.md')

	it('fails before the backup move: nothing changed, staging cleaned', async () => {
		const next = await seeded()
		const outcome = await addSkillInput(next, {}, ctx({ replace: true, ops: failing([1]) }))
		expect(outcome.status).toBe('failed')
		expect(readFileSync(target(), 'utf8')).toContain('old')
		expect(existsSync(join(userDir(), '.staging'))).toBe(false)
	})

	it('fails after the backup move: the old folder is put back', async () => {
		const next = await seeded()
		const ops = failing([2])
		const outcome = await addSkillInput(next, {}, ctx({ replace: true, ops }))
		expect(outcome.status).toBe('failed')
		expect(outcome.message).toContain('put back')
		expect(readFileSync(target(), 'utf8')).toContain('old')
		expect(readdirSync(backups())).toEqual([])
		expect(existsSync(join(userDir(), '.staging'))).toBe(false)
	})

	it('fails after the backup move and cannot put it back: an orphan backup, never a half skill', async () => {
		const next = await seeded()
		const outcome = await addSkillInput(next, {}, ctx({ replace: true, ops: failing([2, 3]) }))
		expect(outcome.status).toBe('failed')
		expect(outcome.message).toContain('The old copy is kept in')
		expect(existsSync(join(userDir(), 'victim'))).toBe(false)
		const [only] = readdirSync(backups())
		expect(readFileSync(join(backups(), only as string, 'SKILL.md'), 'utf8')).toContain('old')
		expect(outcome.backup).toBe(join(backups(), only as string))
	})

	it('a failed first install leaves no folder behind', async () => {
		const outcome = await addSkillInput(put('f.md', md('fresh')), {}, ctx({ ops: failing([1]) }))
		expect(outcome.status).toBe('failed')
		expect(existsSync(join(userDir(), 'fresh'))).toBe(false)
		expect(existsSync(join(userDir(), '.staging'))).toBe(false)
	})
})

describe('create', () => {
	const input = {
		name: 'made-here',
		description: 'Makes a thing.',
		instructions: 'Step one.\nStep two.',
	}

	it('writes through the same writer, with a provenance record', async () => {
		const outcome = await createSkill(input, ctx())
		expect(outcome.status).toBe('added')
		const text = readFileSync(join(userDir(), 'made-here', 'SKILL.md'), 'utf8')
		expect(text).toContain('name: made-here')
		expect(text).toContain('namzu-origin: created')
		expect(text).toContain('Step one.')
		expect(
			JSON.parse(readFileSync(join(userDir(), 'made-here', SKILL_INSTALL_RECORD), 'utf8')).source,
		).toBe('create')
	})

	it('previews inline shell commands and needs a yes, like add', async () => {
		const risky = { ...input, name: 'shc', instructions: 'Run !`echo hi` now' }
		const first = await createSkill(risky, ctx())
		expect(first.status).toBe('needs-consent')
		expect(existsSync(join(userDir(), 'shc'))).toBe(false)
		expect((await createSkill(risky, ctx({ yes: true }))).status).toBe('added')
	})

	it('refuses instructions that start with a frontmatter block', async () => {
		expect(startsWithFrontmatter('---\nname: x\n---\nbody')).toBe(true)
		expect(startsWithFrontmatter('  \n---\nx')).toBe(true)
		expect(startsWithFrontmatter('Intro\n---\nx')).toBe(false)
		const outcome = await createSkill({ ...input, instructions: '---\nname: x\n---\nbody' }, ctx())
		expect(outcome.status).toBe('failed')
		expect(outcome.message).toBe(
			'Your instructions start with a --- block. Remove it: the name and description become the frontmatter.',
		)
	})

	it('applies the shared rules and needs --replace for an existing name', async () => {
		expect((await createSkill({ ...input, name: 'Bad Name' }, ctx())).status).toBe('failed')
		expect((await createSkill({ ...input, description: 'has <b> tags' }, ctx())).message).toContain(
			'tags',
		)
		expect(
			(await createSkill({ ...input, description: 'x'.repeat(1025) }, ctx())).message,
		).toContain('1024')
		await createSkill(input, ctx())
		expect((await createSkill(input, ctx())).status).toBe('needs-consent')
		expect((await createSkill(input, ctx({ replace: true }))).status).toBe('replaced')
	})
})

describe('remove', () => {
	const rctx = (over: Partial<Parameters<typeof removeSkill>[1]> = {}) => ({
		cwd,
		home,
		yes: true,
		now: () => NOW,
		...over,
	})

	it('moves the folder to backups, with the provenance in the details', async () => {
		await addSkillInput(
			zip('z.zip', [file('SKILL.md', md('gone-soon')), file('a.txt', 'a')]),
			{},
			ctx(),
		)
		writeFileSync(join(userDir(), 'gone-soon', 'mine.txt'), 'later')
		const seen: string[] = []
		const outcome = await removeSkill(
			'gone-soon',
			rctx({
				yes: false,
				ask: async (_q, details) => {
					seen.push(...details)
					return true
				},
			}),
		)
		expect(seen.join(' ')).toContain('Added from a file (z.zip)')
		expect(seen.join(' ')).toContain('1 file was added')
		expect(outcome.status).toBe('removed')
		expect(existsSync(join(userDir(), 'gone-soon'))).toBe(false)
		expect(readdirSync(backups())).toEqual([`gone-soon.${NOW.getTime()}`])
		expect(outcome.message).toContain('A copy is in')
		expect(existsSync(join(backups(), `gone-soon.${NOW.getTime()}`, 'mine.txt'))).toBe(true)
	})

	it('refuses to write backups through a link', async () => {
		await addSkillInput(zip('n.zip', [file('SKILL.md', md('nowrap'))]), {}, ctx())
		const elsewhere = join(home, 'elsewhere')
		mkdirSync(elsewhere, { recursive: true })
		mkdirSync(join(home, '.namzu'), { recursive: true })
		symlinkSync(elsewhere, join(home, '.namzu', 'backups'))
		const outcome = await removeSkill('nowrap', rctx())
		expect(outcome.status).toBe('failed')
		expect(existsSync(join(userDir(), 'nowrap'))).toBe(true)
		expect(readdirSync(elsewhere)).toEqual([])
	})

	it('asks first unless --yes, and exits for consent without a terminal', async () => {
		await addSkillInput(put('k.md', md('keep-me')), {}, ctx())
		expect((await removeSkill('keep-me', rctx({ yes: false }))).status).toBe('needs-consent')
		expect(
			(await removeSkill('keep-me', rctx({ yes: false, ask: async () => false }))).status,
		).toBe('declined')
		expect(existsSync(join(userDir(), 'keep-me'))).toBe(true)
	})

	it('refuses a plugin skill, a built-in, a shared folder and a missing name', async () => {
		expect((await removeSkill('ledger__totals', rctx())).message).toBe(
			'This skill comes with plugin "ledger". Turn the plugin off or uninstall it.',
		)
		const builtin =
			discoverSkillRoster({ home, cwd }).skills.find((s) => s.tier === 'system')?.name ?? ''
		expect((await removeSkill(builtin, rctx())).message).toContain(
			'built-in skill and cannot be removed',
		)
		expect((await removeSkill('nothing-here', rctx())).status).toBe('not-found')
		const agents = join(home, '.agents', 'skills', 'shared-one')
		mkdirSync(agents, { recursive: true })
		writeFileSync(join(agents, 'SKILL.md'), md('shared-one'))
		const shared = await removeSkill('shared-one', rctx())
		expect(shared.status).toBe('refused')
		expect(existsSync(agents)).toBe(true)
	})

	it('refuses a skill folder that is a link', async () => {
		const real = join(root, 'real-skill')
		mkdirSync(real)
		writeFileSync(join(real, 'SKILL.md'), md('linked-one'))
		mkdirSync(userDir(), { recursive: true })
		symlinkSync(real, join(userDir(), 'linked-one'))
		const outcome = await removeSkill('linked-one', rctx())
		expect(outcome.status).toBe('unsafe')
		expect(existsSync(real)).toBe(true)
	})

	it('needs --scope when both tiers hold the name, and removes only that tier', async () => {
		await addSkillInput(put('a.md', md('twice')), {}, ctx())
		await addSkillInput(put('b.md', md('twice')), {}, ctx({ scope: 'project' }))
		expect((await removeSkill('twice', rctx())).status).toBe('usage')
		expect((await removeSkill('twice', rctx({ scope: 'project' }))).status).toBe('removed')
		expect(existsSync(join(userDir(), 'twice'))).toBe(true)
		expect(existsSync(join(projectDir(), 'twice'))).toBe(false)
	})

	it('a failed move changes nothing', async () => {
		await addSkillInput(put('q.md', md('stuck')), {}, ctx())
		const outcome = await removeSkill(
			'stuck',
			rctx({
				ops: {
					rename: () => {
						throw new Error('boom')
					},
				},
			}),
		)
		expect(outcome.status).toBe('failed')
		expect(existsSync(join(userDir(), 'stuck', 'SKILL.md'))).toBe(true)
	})
})
