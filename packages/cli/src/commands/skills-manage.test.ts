import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { makeZip } from '../integrations/extensions/__fixtures__/package-builder.js'
import type { TrustDecision } from '../permissions/headless-trust.js'
import { type SkillsManageDeps, type SkillsManageVerb, runSkillsManage } from './skills-manage.js'

let root: string
let home: string
let cwd: string

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-skills-cmd-'))
	home = join(root, 'home')
	cwd = join(root, 'proj')
	mkdirSync(home, { recursive: true })
	mkdirSync(cwd, { recursive: true })
})
afterEach(() => removeTempDir(root))

const NOW = new Date('2026-11-27T10:00:00.000Z')
const md = (name: string, body = 'Do it.') =>
	`---\nname: ${name}\ndescription: Does a thing.\n---\n\n${body}\n`
const write = (rel: string, data: string | Buffer): string => {
	const path = join(root, 'in', rel)
	mkdirSync(join(path, '..'), { recursive: true })
	writeFileSync(path, data)
	return path
}
const userSkill = (name: string) => join(home, '.namzu', 'skills', name, 'SKILL.md')

interface Run {
	code: number
	out: string[]
	err: string[]
	asked: string[]
}

async function run(
	verb: SkillsManageVerb,
	args: string[],
	over: Partial<SkillsManageDeps> & { answers?: string[]; stdin?: string } = {},
): Promise<Run> {
	const out: string[] = []
	const err: string[] = []
	const asked: string[] = []
	const answers = [...(over.answers ?? [])]
	const trusted: TrustDecision = { allowed: true, cwd }
	const deps: SkillsManageDeps = {
		out: (t) => out.push(t),
		err: (t) => err.push(t),
		isTTY: false,
		ask: async (q) => {
			asked.push(q)
			return answers.shift() ?? 'n'
		},
		readStdin: async () => over.stdin ?? '',
		cwd: () => cwd,
		home,
		now: () => NOW,
		trust: () => trusted,
		...over,
	}
	const code = await runSkillsManage(verb, args, deps)
	return { code, out, err, asked }
}

describe('namzu skills add', () => {
	it('adds a file: exit 0, the sentence on stdout', async () => {
		const r = await run('add', [write('a.md', md('weekly-report'))])
		expect(r.code).toBe(0)
		expect(r.out).toEqual([
			'Added skill "weekly-report" to your skills (1 file). It is available from your next message.',
		])
		expect(existsSync(userSkill('weekly-report'))).toBe(true)
	})

	it('adds several inputs independently: a failure gives exit 1 and names each', async () => {
		const good = write('good.md', md('good-one'))
		const bad = write('bad.md', 'no frontmatter')
		const r = await run('add', [good, bad])
		expect(r.code).toBe(1)
		expect(r.out.join('\n')).toContain(`${good}: Added skill "good-one"`)
		expect(r.err.join('\n')).toContain(
			`${bad}: A .md file must contain the skill name and description formatted in YAML.`,
		)
		expect(existsSync(userSkill('good-one'))).toBe(true)
	})

	it('exits 65 when every input is refused as unsafe, and writes nothing', async () => {
		const evil = write(
			'e.zip',
			makeZip([
				{ name: 'SKILL.md', data: Buffer.from(md('evil')) },
				{ name: 'x', data: Buffer.from('t'), mode: 0o120777 },
			]),
		)
		const slip = write('s.zip', makeZip([{ name: '../SKILL.md', data: Buffer.from(md('slip')) }]))
		const r = await run('add', [evil, slip])
		expect(r.code).toBe(65)
		expect(existsSync(userSkill('evil'))).toBe(false)
	})

	it('exits 75 for a skill that runs commands when nobody can be asked, 0 with --yes', async () => {
		const path = write('r.md', md('runs', 'Now: !`date`'))
		const none = await run('add', [path])
		expect(none.code).toBe(75)
		expect(none.err.join('\n')).toContain('Runs commands: date')
		expect(none.err.join('\n')).toContain('--yes')
		expect(existsSync(userSkill('runs'))).toBe(false)
		const yes = await run('add', ['--yes', path])
		expect(yes.code).toBe(0)
		expect(existsSync(userSkill('runs'))).toBe(true)
	})

	it('asks at a terminal, shows the preview on stderr, and adds on a yes', async () => {
		const path = write('r2.md', md('runs-too', '!`ls`'))
		const no = await run('add', [path], { isTTY: true, answers: ['n'] })
		expect(no.code).toBe(1)
		expect(no.err.join('\n')).toContain('Runs commands: ls')
		expect(existsSync(userSkill('runs-too'))).toBe(false)
		const yes = await run('add', [path], { isTTY: true, answers: ['y'] })
		expect(yes.code).toBe(0)
		expect(yes.asked[0]).toContain('Add skill "runs-too"')
	})

	it('needs --replace for an existing name', async () => {
		const path = write('d.md', md('dup'))
		await run('add', [path])
		expect((await run('add', [path])).code).toBe(75)
		const again = await run('add', ['--replace', path])
		expect(again.code).toBe(0)
		expect(again.out[0]).toContain('Replaced skill "dup"')
	})

	it('--json prints one object and keeps the question off stdout', async () => {
		const path = write('j.md', md('json-skill', '!`ls`'))
		const need = await run('add', ['--json', path])
		expect(need.code).toBe(75)
		expect(need.out).toHaveLength(1)
		const first = JSON.parse(need.out[0] as string)
		expect(first).toMatchObject({ version: 1, ok: false, exitCode: 75, added: 0 })
		expect(first.results[0]).toMatchObject({ status: 'needs-consent', name: 'json-skill' })
		expect(first.results[0].preview[0]).toContain('Runs commands')

		const done = await run('add', ['--json', '--yes', path], { isTTY: true })
		const object = JSON.parse(done.out[0] as string)
		expect(object).toMatchObject({ version: 1, ok: true, exitCode: 0, added: 1 })
		expect(object.results[0]).toMatchObject({
			input: path,
			status: 'added',
			name: 'json-skill',
			scope: 'user',
			files: 1,
			path: userSkill('json-skill'),
		})
		expect(done.out).toHaveLength(1)
	})

	it('adds to the project only in a trusted folder', async () => {
		const path = write('p.md', md('proj-one'))
		const untrusted = await run('add', ['--scope', 'project', path], {
			trust: () => ({ allowed: false, message: 'no' }),
		})
		expect(untrusted.code).toBe(77)
		expect(existsSync(join(cwd, '.namzu', 'skills', 'proj-one'))).toBe(false)
		const ok = await run('add', ['--scope=project', path])
		expect(ok.code).toBe(0)
		expect(ok.out[0]).toContain("this project's skills")
		// A user skill is allowed from an untrusted folder, and does not read that folder's skills.
		const user = await run('add', [write('u.md', md('user-one'))], {
			trust: () => ({ allowed: false, message: 'no' }),
		})
		expect(user.code).toBe(0)
	})

	it('--name renames one input, and is a usage error with several', async () => {
		const path = write('n.md', md('old'))
		expect((await run('add', ['--name', 'new-name', path])).code).toBe(0)
		expect(existsSync(userSkill('new-name'))).toBe(true)
		const two = await run('add', ['--name', 'x', path, path])
		expect(two.code).toBe(64)
	})

	it('answers usage mistakes with exit 64', async () => {
		expect((await run('add', [])).code).toBe(64)
		expect((await run('add', ['--scope', 'team', 'x'])).code).toBe(64)
		expect((await run('add', ['--bogus', 'x'])).code).toBe(64)
		expect((await run('add', ['--scope'])).code).toBe(64)
		expect((await run('add', ['--yes=1', 'x'])).code).toBe(64)
		expect((await run('add', ['--cwd', join(root, 'nope'), 'x'])).code).toBe(64)
		const many = await run(
			'add',
			Array.from({ length: 21 }, (_, i) => `f${i}.md`),
		)
		expect(many.code).toBe(64)
		expect(many.err[0]).toBe('You can add up to 20 skills at a time.')
		const json = await run('add', ['--json'])
		expect(JSON.parse(json.out[0] as string)).toMatchObject({ ok: false })
	})

	it('takes up to 20 inputs', async () => {
		const files = Array.from({ length: 20 }, (_, i) => write(`m${i}.md`, md(`many-${i}`)))
		const r = await run('add', files)
		expect(r.code).toBe(0)
		expect(r.out).toHaveLength(20)
	})

	it('prints help', async () => {
		const r = await run('add', ['--help'])
		expect(r.code).toBe(0)
		expect(r.out[0]).toContain('namzu skills add')
	})
})

describe('namzu skills create', () => {
	it('creates from flags', async () => {
		const r = await run('create', [
			'made',
			'--description',
			'Makes it.',
			'--instructions',
			'Do the steps.',
		])
		expect(r.code).toBe(0)
		expect(readFileSync(userSkill('made'), 'utf8')).toContain('Do the steps.')
	})

	it('reads the instructions from standard input with -, and from a file', async () => {
		const stdin = await run(
			'create',
			['from-stdin', '--description', 'd', '--instructions-file', '-'],
			{
				stdin: 'Typed in.\n',
			},
		)
		expect(stdin.code).toBe(0)
		expect(readFileSync(userSkill('from-stdin'), 'utf8')).toContain('Typed in.')
		const path = write('ins.txt', 'From a file.')
		expect(
			(await run('create', ['from-file', '--description', 'd', '--instructions-file', path])).code,
		).toBe(0)
		const missing = await run('create', [
			'nofile',
			'--description',
			'd',
			'--instructions-file',
			join(root, 'gone'),
		])
		expect(missing.code).toBe(66)
	})

	it('refuses a leading --- block, a bad name and a missing flag', async () => {
		const front = await run('create', [
			'x',
			'--description',
			'd',
			'--instructions',
			'---\nname: x\n---\nb',
		])
		expect(front.code).toBe(1)
		expect(front.err[0]).toBe(
			'Your instructions start with a --- block. Remove it: the name and description become the frontmatter.',
		)
		expect(
			(await run('create', ['Bad Name', '--description', 'd', '--instructions', 'b'])).code,
		).toBe(1)
		expect((await run('create', ['x', '--instructions', 'b'])).code).toBe(64)
		expect((await run('create', ['x', '--description', 'd'])).code).toBe(64)
		expect(
			(
				await run('create', [
					'x',
					'--description',
					'd',
					'--instructions',
					'a',
					'--instructions-file',
					'-',
				])
			).code,
		).toBe(64)
		expect(
			(await run('create', ['x', '--yes', '--description', 'd', '--instructions', 'a'])).code,
		).toBe(64)
	})

	it('needs --replace for an existing name and prints JSON', async () => {
		const args = ['dupe', '--description', 'd', '--instructions', 'b']
		await run('create', args)
		expect((await run('create', args)).code).toBe(75)
		const r = await run('create', [...args, '--replace', '--json'])
		expect(r.code).toBe(0)
		expect(JSON.parse(r.out[0] as string).results[0]).toMatchObject({
			status: 'replaced',
			name: 'dupe',
		})
	})
})

describe('namzu skills remove', () => {
	it('exits 75 without a terminal and without --yes, then removes with --yes', async () => {
		await run('create', ['bye', '--description', 'd', '--instructions', 'b'])
		const none = await run('remove', ['bye'])
		expect(none.code).toBe(75)
		expect(existsSync(userSkill('bye'))).toBe(true)
		const r = await run('remove', ['bye', '--yes'])
		expect(r.code).toBe(0)
		expect(r.out[0]).toContain('Removed. A copy is in')
		expect(r.out[0]).toContain(`bye.${NOW.getTime()}`)
		expect(existsSync(userSkill('bye'))).toBe(false)
	})

	it('asks at a terminal', async () => {
		await run('create', ['ask-me', '--description', 'd', '--instructions', 'b'])
		const no = await run('remove', ['ask-me'], { isTTY: true, answers: ['n'] })
		expect(no.code).toBe(1)
		expect(existsSync(userSkill('ask-me'))).toBe(true)
		const yes = await run('remove', ['ask-me'], { isTTY: true, answers: ['yes'] })
		expect(yes.code).toBe(0)
	})

	it('answers not found with 66, a plugin skill with a reason, and JSON with the shape', async () => {
		expect((await run('remove', ['nothing', '--yes'])).code).toBe(66)
		const plugin = await run('remove', ['ledger__totals', '--yes'])
		expect(plugin.code).toBe(1)
		expect(plugin.err[0]).toBe(
			'This skill comes with plugin "ledger". Turn the plugin off or uninstall it.',
		)
		await run('create', ['jsonrm', '--description', 'd', '--instructions', 'b'])
		const j = await run('remove', ['jsonrm', '--yes', '--json'])
		expect(JSON.parse(j.out[0] as string)).toMatchObject({
			version: 1,
			ok: true,
			status: 'removed',
			name: 'jsonrm',
			scope: 'user',
		})
		expect((await run('remove', [])).code).toBe(64)
	})
})
