import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { hooksOf, useSkillHooksByName } from './use-hooks.js'

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

function project(): string {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-use-hooks-'))
	roots.push(cwd)
	for (const [name, hooks] of [
		['guarded', 'hooks:\n  Stop: []\n'],
		['plain', ''],
	] as const) {
		const dir = join(cwd, '.namzu', 'skills', name)
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n${hooks}---\nBody`)
	}
	return cwd
}

describe('a skill the person ran by name', () => {
	it('attaches the hooks of the named skills that carry any, with the skill’s folder', () => {
		const cwd = project()
		const used: unknown[] = []
		const said: string[] = []
		useSkillHooksByName(
			{ use: (skill) => used.push(skill) },
			{ cwd },
			['guarded', 'plain', 'nothing'],
			(l) => said.push(l),
		)
		expect(used).toEqual([
			{
				name: 'guarded',
				dirPath: join(cwd, '.namzu', 'skills', 'guarded'),
				hooksSource: 'hooks:\n  Stop: []',
			},
		])
		expect(said).toEqual([])
	})

	it('says so once when the session has no way to attach them', () => {
		const said: string[] = []
		useSkillHooksByName(undefined, { cwd: project() }, ['guarded', 'plain'], (l) => said.push(l))
		expect(said).toEqual([
			'Skill guarded carries hooks, but this session has no hook runtime, so they are not attached.',
		])
	})

	it('does nothing for a skill without hooks', () => {
		expect(hooksOf({ name: 'a', path: '/s/a/SKILL.md' })).toBeUndefined()
	})
})
