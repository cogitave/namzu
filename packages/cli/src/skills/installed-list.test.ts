import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { listInstalledSkills } from './installed-list.js'

let home: string
let cwd: string
let system: string

function skill(root: string, dir: string, name: string) {
	const folder = join(root, dir)
	mkdirSync(folder, { recursive: true })
	writeFileSync(
		join(folder, 'SKILL.md'),
		`---\nname: ${name}\ndescription: does ${name}\n---\nBody.`,
	)
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-inst-h-'))
	cwd = mkdtempSync(join(tmpdir(), 'namzu-inst-c-'))
	system = mkdtempSync(join(tmpdir(), 'namzu-inst-s-'))
	skill(system, 'ship', 'ship')
	skill(join(home, '.namzu', 'skills'), 'mine', 'mine')
	skill(join(cwd, '.namzu', 'skills'), 'local', 'local')
})
afterEach(() => {
	for (const dir of [home, cwd, system]) removeTempDir(dir)
})

describe('the installed skills Settings lists', () => {
	it('names each skill with its tier in the person’s words, and nothing else', () => {
		const list = listInstalledSkills({ cwd, includeProject: true, home, systemDir: system })
		expect(list).toEqual([
			{ name: 'local', tier: 'project', where: expect.stringContaining('.namzu') },
			{ name: 'mine', tier: 'user', where: expect.stringContaining('.namzu') },
			{ name: 'ship', tier: 'system', where: 'built-in' },
		])
		for (const item of list) expect(Object.keys(item).sort()).toEqual(['name', 'tier', 'where'])
	})

	it('leaves out the project’s skills for a folder nobody trusted', () => {
		const list = listInstalledSkills({ cwd, includeProject: false, home, systemDir: system })
		expect(list.map((item) => item.name)).toEqual(['mine', 'ship'])
	})

	it('lists one entry per name, from the highest tier', () => {
		skill(join(cwd, '.namzu', 'skills'), 'shadow', 'mine')
		const list = listInstalledSkills({ cwd, includeProject: true, home, systemDir: system })
		expect(list.filter((item) => item.name === 'mine')).toEqual([
			{ name: 'mine', tier: 'project', where: expect.any(String) },
		])
	})
})
