import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import {
	SKILL_PAL_MESSAGE,
	SKILL_STAGE_MAX,
	SKILL_STAGE_TTL_MS,
	SKILL_TRUST_MESSAGE,
	STAGE_CHANGED_MESSAGE,
	STAGE_GONE_MESSAGE,
	createDesktopSkillActions,
} from './desktop-host-skills.js'

let root: string
let home: string
let cwd: string
let inputs: string
let trusted = true
let pal = false

beforeEach(() => {
	vi.useFakeTimers()
	vi.setSystemTime(new Date('2026-11-27T10:00:00.000Z'))
	root = mkdtempSync(join(tmpdir(), 'namzu-host-skills-'))
	home = join(root, 'home')
	cwd = join(root, 'proj')
	inputs = join(root, 'in')
	for (const d of [home, cwd, inputs]) mkdirSync(d, { recursive: true })
	trusted = true
	pal = false
})
afterEach(() => {
	vi.useRealTimers()
	removeTempDir(root)
})

const actions = () =>
	createDesktopSkillActions({ cwd, home, pal: () => pal, isTrusted: () => trusted })

const md = (name: string, body = 'Do the thing.', description = 'Does a thing. Use when asked.') =>
	['---', `name: ${name}`, `description: ${description}`, '---', '', body, ''].join('\n')
const put = (file: string, text: string): string => {
	const path = join(inputs, file)
	writeFileSync(path, text)
	return path
}
const userSkill = (name: string) => join(home, '.namzu', 'skills', name, 'SKILL.md')
const projectSkill = (name: string) => join(cwd, '.namzu', 'skills', name, 'SKILL.md')

type StageAnswer = {
	stageId: string
	expiresAt: string
	items: {
		fileName: string
		kind: string
		name?: string
		description?: string
		files?: number
		bytes?: number
		findings: string[]
		grants: string[]
		scripts: string[]
		collides?: string[]
		error?: string
	}[]
}
type InstallAnswer = {
	results: { name: string; outcome: string; path?: string; error?: string }[]
	note?: string
}

describe('namzu/skills/stage', () => {
	it('reads a file and says what it is, writing nothing', async () => {
		const { methods } = actions()
		const path = put('weekly.md', md('weekly-report'))
		const answer = (await methods['namzu/skills/stage']({ paths: [path] })) as StageAnswer
		expect(answer.items).toEqual([
			{
				fileName: 'weekly.md',
				kind: 'file',
				name: 'weekly-report',
				description: 'Does a thing. Use when asked.',
				files: 1,
				bytes: Buffer.byteLength(md('weekly-report')),
				findings: [],
				grants: [],
				scripts: [],
			},
		])
		expect(answer.expiresAt).toBe(new Date(Date.now() + SKILL_STAGE_TTL_MS).toISOString())
		expect(existsSync(join(home, '.namzu'))).toBe(false)
		expect(existsSync(join(cwd, '.namzu'))).toBe(false)
	})

	it('shows what a skill can run and the scripts it ships', async () => {
		const { methods } = actions()
		const dir = join(inputs, 'runner')
		mkdirSync(join(dir, 'scripts'), { recursive: true })
		writeFileSync(join(dir, 'SKILL.md'), md('runner', 'Now: !`date`'))
		writeFileSync(join(dir, 'scripts', 'go.sh'), '#!/bin/sh\n')
		const answer = (await methods['namzu/skills/stage']({ paths: [dir] })) as StageAnswer
		const item = answer.items[0]
		expect(item?.kind).toBe('folder')
		expect(item?.grants.join(' ')).toContain('Runs commands: date')
		expect(item?.scripts).toEqual(['scripts/go.sh'])
	})

	it('reports a bad input per item and keeps the good ones', async () => {
		const { methods } = actions()
		const good = put('ok.md', md('ok-skill'))
		const wrong = put('notes.txt', 'x')
		const link = join(inputs, 'link.md')
		symlinkSync(good, link)
		const answer = (await methods['namzu/skills/stage']({
			paths: [good, wrong, link, 'relative/path.md', join(inputs, 'gone.md')],
		})) as StageAnswer
		expect(answer.items.map((i) => [i.fileName, i.name, i.error !== undefined])).toEqual([
			['ok.md', 'ok-skill', false],
			['notes.txt', undefined, true],
			['link.md', undefined, true],
			['path.md', undefined, true],
			['gone.md', undefined, true],
		])
		expect(answer.items[1]?.error).toContain('.skill, .zip, or .md')
		expect(answer.items[2]?.error).toContain('is a link')
	})

	it('marks where a skill of the same name already is, the project only once it is trusted', async () => {
		const { methods } = actions()
		mkdirSync(join(home, '.namzu', 'skills', 'same'), { recursive: true })
		writeFileSync(userSkill('same'), md('same'))
		mkdirSync(join(cwd, '.namzu', 'skills', 'same'), { recursive: true })
		writeFileSync(projectSkill('same'), md('same'))
		const path = put('same.md', md('same'))
		const open = (await methods['namzu/skills/stage']({ paths: [path] })) as StageAnswer
		expect(open.items[0]?.collides).toEqual(['user', 'project'])
		trusted = false
		const closed = (await methods['namzu/skills/stage']({ paths: [path] })) as StageAnswer
		expect(closed.items[0]?.collides).toEqual(['user'])
	})

	it('takes exact keys and 1 to 20 paths', async () => {
		const { methods } = actions()
		const path = put('a.md', md('a-skill'))
		await expect(methods['namzu/skills/stage']({ paths: [path], extra: 1 })).rejects.toThrow(
			'Invalid skill stage request.',
		)
		await expect(methods['namzu/skills/stage']({})).rejects.toThrow('Invalid skill stage request.')
		await expect(methods['namzu/skills/stage']({ paths: [] })).rejects.toThrow('between 1 and 20')
		await expect(
			methods['namzu/skills/stage']({ paths: Array.from({ length: 21 }, (_, i) => `/x/${i}.md`) }),
		).rejects.toThrow('between 1 and 20')
		await expect(methods['namzu/skills/stage']({ paths: [5] })).rejects.toThrow('between 1 and 20')
	})

	it('keeps at most four stages and drops the oldest', async () => {
		const { methods, stages } = actions()
		const path = put('a.md', md('a-skill'))
		const ids: string[] = []
		for (let i = 0; i < SKILL_STAGE_MAX + 1; i++)
			ids.push(((await methods['namzu/skills/stage']({ paths: [path] })) as StageAnswer).stageId)
		expect(stages.size).toBe(SKILL_STAGE_MAX)
		expect(stages.has(ids[0] as string)).toBe(false)
		expect(stages.has(ids[SKILL_STAGE_MAX] as string)).toBe(true)
	})

	it('refuses a Pal', async () => {
		const { methods } = actions()
		pal = true
		await expect(methods['namzu/skills/stage']({ paths: ['/x.md'] })).rejects.toThrow(
			SKILL_PAL_MESSAGE,
		)
	})
})

describe('namzu/skills/install', () => {
	const stage = async (m: ReturnType<typeof actions>['methods'], ...paths: string[]) =>
		(await m['namzu/skills/stage']({ paths })) as StageAnswer

	it('writes the staged skill to the chosen place and uses the stage once', async () => {
		const { methods } = actions()
		const { stageId } = await stage(methods, put('a.md', md('a-skill')))
		const answer = (await methods['namzu/skills/install']({
			stageId,
			scope: 'user',
			replace: [],
			accept: [],
		})) as InstallAnswer
		expect(answer.results).toEqual([
			{ name: 'a-skill', outcome: 'added', path: userSkill('a-skill') },
		])
		expect(answer.note).toBe('It loads in new conversations.')
		expect(readFileSync(userSkill('a-skill'), 'utf8')).toContain('name: a-skill')
		await expect(
			methods['namzu/skills/install']({ stageId, scope: 'user', replace: [], accept: [] }),
		).rejects.toThrow(STAGE_GONE_MESSAGE)
	})

	it('installs into the project when it is trusted', async () => {
		const { methods } = actions()
		const { stageId } = await stage(methods, put('a.md', md('a-skill')))
		await methods['namzu/skills/install']({ stageId, scope: 'project' })
		expect(existsSync(projectSkill('a-skill'))).toBe(true)
	})

	it('refuses the project scope for a folder nobody trusted, and keeps the stage', async () => {
		const { methods, stages } = actions()
		const { stageId } = await stage(methods, put('a.md', md('a-skill')))
		trusted = false
		await expect(methods['namzu/skills/install']({ stageId, scope: 'project' })).rejects.toThrow(
			SKILL_TRUST_MESSAGE,
		)
		expect(stages.has(stageId)).toBe(true)
		expect(existsSync(projectSkill('a-skill'))).toBe(false)
		const user = (await methods['namzu/skills/install']({
			stageId,
			scope: 'user',
		})) as InstallAnswer
		expect(user.results[0]?.outcome).toBe('added')
	})

	it('fails an item that would replace another unless the person chose to replace it', async () => {
		const { methods } = actions()
		const first = await stage(methods, put('a.md', md('a-skill', 'One.')))
		await methods['namzu/skills/install']({ stageId: first.stageId, scope: 'user' })
		const second = await stage(methods, put('b.md', md('a-skill', 'Two.')))
		const refused = (await methods['namzu/skills/install']({
			stageId: second.stageId,
			scope: 'user',
		})) as InstallAnswer
		expect(refused.results[0]).toMatchObject({ name: 'a-skill', outcome: 'failed' })
		expect(readFileSync(userSkill('a-skill'), 'utf8')).toContain('One.')
		const third = await stage(methods, put('c.md', md('a-skill', 'Three.')))
		const replaced = (await methods['namzu/skills/install']({
			stageId: third.stageId,
			scope: 'user',
			replace: ['a-skill'],
		})) as InstallAnswer
		expect(replaced.results[0]?.outcome).toBe('replaced')
		expect(readFileSync(userSkill('a-skill'), 'utf8')).toContain('Three.')
		expect(readdirSync(join(home, '.namzu', 'backups', 'skills')).length).toBe(1)
	})

	it('needs an accept for a skill that can run commands, and items are independent', async () => {
		const { methods } = actions()
		const { stageId } = await stage(
			methods,
			put('r.md', md('runs-things', 'Now: !`date`')),
			put('p.md', md('plain-one')),
		)
		const first = (await methods['namzu/skills/install']({
			stageId,
			scope: 'user',
			accept: [],
		})) as InstallAnswer
		expect(first.results.map((r) => [r.name, r.outcome])).toEqual([
			['runs-things', 'failed'],
			['plain-one', 'added'],
		])
		expect(first.results[0]?.error).toBe('Accept what it can run first.')
		const again = await stage(methods, put('r2.md', md('runs-things', 'Now: !`date`')))
		const done = (await methods['namzu/skills/install']({
			stageId: again.stageId,
			scope: 'user',
			accept: ['runs-things'],
		})) as InstallAnswer
		expect(done.results[0]?.outcome).toBe('added')
	})

	it('refuses names that are not in the stage', async () => {
		const { methods } = actions()
		const { stageId } = await stage(methods, put('a.md', md('a-skill')))
		await expect(
			methods['namzu/skills/install']({ stageId, scope: 'user', accept: ['other'] }),
		).rejects.toThrow(STAGE_CHANGED_MESSAGE)
		await expect(
			methods['namzu/skills/install']({ stageId, scope: 'user', replace: ['other'] }),
		).rejects.toThrow(STAGE_CHANGED_MESSAGE)
		expect(existsSync(userSkill('a-skill'))).toBe(false)
	})

	it('refuses when what is held no longer matches what was shown', async () => {
		const { methods, stages } = actions()
		const { stageId } = await stage(methods, put('a.md', md('a-skill')))
		const held = stages.get(stageId)?.items[0]?.prepared
		;(held?.files as Map<string, { bytes: Buffer; executable: boolean }> | undefined)?.set(
			'SKILL.md',
			{ bytes: Buffer.from('changed'), executable: false },
		)
		await expect(methods['namzu/skills/install']({ stageId, scope: 'user' })).rejects.toThrow(
			STAGE_CHANGED_MESSAGE,
		)
		expect(existsSync(userSkill('a-skill'))).toBe(false)
	})

	it('forgets a stage after ten minutes', async () => {
		const { methods } = actions()
		const { stageId } = await stage(methods, put('a.md', md('a-skill')))
		vi.advanceTimersByTime(SKILL_STAGE_TTL_MS - 1)
		const ok = await stage(methods, put('b.md', md('b-skill')))
		expect(ok.stageId).not.toBe(stageId)
		vi.advanceTimersByTime(1)
		await expect(methods['namzu/skills/install']({ stageId, scope: 'user' })).rejects.toThrow(
			STAGE_GONE_MESSAGE,
		)
		const live = (await methods['namzu/skills/install']({
			stageId: ok.stageId,
			scope: 'user',
		})) as InstallAnswer
		expect(live.results[0]?.outcome).toBe('added')
	})

	it('takes exact keys and a known scope, and refuses a Pal', async () => {
		const { methods } = actions()
		const { stageId } = await stage(methods, put('a.md', md('a-skill')))
		await expect(
			methods['namzu/skills/install']({ stageId, scope: 'user', path: '/x' }),
		).rejects.toThrow('Invalid skill install request.')
		await expect(methods['namzu/skills/install']({ stageId, scope: 'team' })).rejects.toThrow(
			'Invalid scope.',
		)
		await expect(methods['namzu/skills/install']({ scope: 'user' })).rejects.toThrow(
			'Invalid skill install request.',
		)
		await expect(
			methods['namzu/skills/install']({ stageId, scope: 'user', accept: [1] }),
		).rejects.toThrow('Invalid accept.')
		pal = true
		await expect(methods['namzu/skills/install']({ stageId, scope: 'user' })).rejects.toThrow(
			SKILL_PAL_MESSAGE,
		)
	})
})

describe('namzu/skills/create', () => {
	const form = {
		name: 'weekly-report',
		description: 'Writes the weekly report. Use when asked.',
		instructions: 'Summarise the week.',
		scope: 'user',
	}

	it('writes the skill with the same writer as a file', async () => {
		const { methods } = actions()
		const answer = await methods['namzu/skills/create'](form)
		expect(answer).toEqual({
			outcome: 'created',
			path: userSkill('weekly-report'),
			note: 'It loads in new conversations.',
		})
		expect(readFileSync(userSkill('weekly-report'), 'utf8')).toContain('Summarise the week.')
	})

	it('says it exists unless the person chose to replace it', async () => {
		const { methods } = actions()
		await methods['namzu/skills/create'](form)
		const exists = (await methods['namzu/skills/create']({
			...form,
			instructions: 'Changed.',
		})) as { outcome: string }
		expect(exists.outcome).toBe('exists')
		expect(readFileSync(userSkill('weekly-report'), 'utf8')).toContain('Summarise the week.')
		const replaced = (await methods['namzu/skills/create']({
			...form,
			instructions: 'Changed.',
			replace: true,
		})) as { outcome: string }
		expect(replaced.outcome).toBe('created')
		expect(readFileSync(userSkill('weekly-report'), 'utf8')).toContain('Changed.')
	})

	it('fails with a sentence for a name or instructions the checks refuse', async () => {
		const { methods } = actions()
		const badName = (await methods['namzu/skills/create']({ ...form, name: 'Bad Name' })) as {
			outcome: string
			error?: string
		}
		expect(badName.outcome).toBe('failed')
		expect(badName.error).toBeTruthy()
		const frontmatter = (await methods['namzu/skills/create']({
			...form,
			instructions: '---\nname: x\n---\nBody',
		})) as { outcome: string; error?: string }
		expect(frontmatter.outcome).toBe('failed')
		expect(frontmatter.error).toContain('Remove it')
	})

	it('caps every field and takes exact keys', async () => {
		const { methods } = actions()
		await expect(methods['namzu/skills/create']({ ...form, name: 'x'.repeat(65) })).rejects.toThrow(
			'Invalid name.',
		)
		await expect(
			methods['namzu/skills/create']({ ...form, description: 'x'.repeat(1025) }),
		).rejects.toThrow('Invalid description.')
		await expect(
			methods['namzu/skills/create']({ ...form, instructions: 'x'.repeat(70 * 1024) }),
		).rejects.toThrow('Invalid instructions.')
		await expect(methods['namzu/skills/create']({ ...form, extra: 1 })).rejects.toThrow(
			'Invalid skill create request.',
		)
		await expect(methods['namzu/skills/create']({ ...form, replace: 'yes' })).rejects.toThrow(
			'Invalid replace.',
		)
		await expect(methods['namzu/skills/create']({ ...form, scope: 'all' })).rejects.toThrow(
			'Invalid scope.',
		)
		expect(existsSync(userSkill('weekly-report'))).toBe(false)
	})

	it('refuses the project scope when nobody trusted the folder, and a Pal', async () => {
		const { methods } = actions()
		trusted = false
		await expect(methods['namzu/skills/create']({ ...form, scope: 'project' })).rejects.toThrow(
			SKILL_TRUST_MESSAGE,
		)
		pal = true
		await expect(methods['namzu/skills/create'](form)).rejects.toThrow(SKILL_PAL_MESSAGE)
	})
})

describe('namzu/skills/remove', () => {
	it('moves a skill into the backups folder and never deletes it', async () => {
		const { methods } = actions()
		await methods['namzu/skills/create']({
			name: 'gone-soon',
			description: 'Does a thing. Use when asked.',
			instructions: 'Body.',
			scope: 'user',
		})
		const answer = (await methods['namzu/skills/remove']({
			name: 'gone-soon',
			tier: 'user',
		})) as { outcome: string; backup?: string }
		expect(answer.outcome).toBe('removed')
		expect(existsSync(userSkill('gone-soon'))).toBe(false)
		expect(readFileSync(join(answer.backup as string, 'SKILL.md'), 'utf8')).toContain('Body.')
	})

	it('answers why not, in words, for a skill that is not there or is built in', async () => {
		const { methods } = actions()
		const missing = (await methods['namzu/skills/remove']({ name: 'nothing', tier: 'user' })) as {
			outcome: string
			error?: string
		}
		expect(missing).toMatchObject({ outcome: 'not-found' })
		expect(missing.error).toContain('No skill named')
	})

	it('takes exact keys, refuses an untrusted project and a Pal', async () => {
		const { methods } = actions()
		await expect(
			methods['namzu/skills/remove']({ name: 'a', tier: 'user', yes: true }),
		).rejects.toThrow('Invalid skill remove request.')
		await expect(methods['namzu/skills/remove']({ name: 'a', tier: 'system' })).rejects.toThrow(
			'Invalid tier.',
		)
		await expect(methods['namzu/skills/remove']({ name: '', tier: 'user' })).rejects.toThrow(
			'Invalid name.',
		)
		trusted = false
		await expect(methods['namzu/skills/remove']({ name: 'a', tier: 'project' })).rejects.toThrow(
			SKILL_TRUST_MESSAGE,
		)
		pal = true
		await expect(methods['namzu/skills/remove']({ name: 'a', tier: 'user' })).rejects.toThrow(
			SKILL_PAL_MESSAGE,
		)
	})
})
