import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { localSettingsPath } from '../permissions/local-settings.js'
import {
	baseSkillState,
	formatTokenCost,
	nextSkillState,
	saveSkillOverrides,
	skillListingTokens,
	skillStateOf,
} from './overrides.js'
import { type SkillInfo, discoverSkills } from './store.js'

let cwd: string
let home: string
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), 'namzu-ovr-cwd-'))
	home = mkdtempSync(join(tmpdir(), 'namzu-ovr-home-'))
})
afterEach(() => {
	removeTempDir(cwd)
	removeTempDir(home)
})

const read = (): Record<string, unknown> => JSON.parse(readFileSync(localSettingsPath(cwd), 'utf8'))

function skill(name: string): void {
	mkdirSync(join(cwd, '.namzu', 'skills', name), { recursive: true })
	writeFileSync(
		join(cwd, '.namzu', 'skills', name, 'SKILL.md'),
		`---\nname: ${name}\ndescription: does ${name}\n---\nBody.`,
	)
}

describe('the states a skill cycles through', () => {
	it('goes on, name-only, user-only, off, and back to on', () => {
		const seen = ['on']
		for (let i = 0; i < 4; i++) seen.push(nextSkillState(seen[seen.length - 1] as never))
		expect(seen).toEqual(['on', 'name-only', 'user-only', 'off', 'on'])
	})

	it('reads the state from the roster, off first', () => {
		skill('a')
		skill('b')
		skill('c')
		skill('d')
		const states = Object.fromEntries(
			discoverSkills({
				cwd,
				home,
				config: {
					builtin: false,
					disabled: ['d'],
					overrides: { a: 'name-only', b: 'user-only', c: 'off', d: 'on' },
				},
			}).map((info: SkillInfo) => [info.name, skillStateOf(info)]),
		)
		expect(states).toEqual({ a: 'name-only', b: 'user-only', c: 'off', d: 'on' })
	})

	it('treats a name in skills.disabled as off when no override says otherwise', () => {
		skill('a')
		const [info] = discoverSkills({ cwd, home, config: { builtin: false, disabled: ['a'] } })
		expect(skillStateOf(info as SkillInfo)).toBe('off')
		expect(baseSkillState('a', ['a'])).toBe('off')
		expect(baseSkillState('a', undefined)).toBe('on')
		expect(baseSkillState('a', ['a'], { a: 'user-only' })).toBe('user-only')
		expect(baseSkillState('a', undefined, { a: 'user-only' }, new Set(['a']))).toBeUndefined()
	})
})

describe('what a listing costs', () => {
	it('rounds to ten tokens and says "< 20" under twenty', () => {
		expect(formatTokenCost(4)).toBe('< 20 tokens')
		expect(formatTokenCost(19)).toBe('< 20 tokens')
		expect(formatTokenCost(20)).toBe('~20 tokens')
		expect(formatTokenCost(64)).toBe('~60 tokens')
		expect(formatTokenCost(65)).toBe('~70 tokens')
	})

	it('estimates from the name and description at four characters a token', () => {
		expect(skillListingTokens({ name: 'a'.repeat(40), description: 'b'.repeat(160) })).toBe(50)
	})
})

describe('saving the screen to the local settings file', () => {
	it('writes the changed keys under skills.overrides and keeps the rest of the file', () => {
		mkdirSync(join(cwd, '.namzu'), { recursive: true })
		writeFileSync(
			localSettingsPath(cwd),
			JSON.stringify({ permissions: { Bash: 'ask' }, skills: { suggest: false } }),
		)
		const saved = saveSkillOverrides(cwd, { a: 'name-only', b: 'off' }, { trusted: true })
		expect(saved).toEqual({ ok: true, changed: 2 })
		expect(read()).toEqual({
			permissions: { Bash: 'ask' },
			skills: { suggest: false, overrides: { a: 'name-only', b: 'off' } },
		})
	})

	it('takes a key out when its value is null, and the skills table when nothing is left', () => {
		saveSkillOverrides(cwd, { a: 'off' }, { trusted: true })
		expect(read()).toEqual({ skills: { overrides: { a: 'off' } } })
		saveSkillOverrides(cwd, { a: null }, { trusted: true })
		expect(read()).toEqual({})
	})

	it('writes nothing for no changes', () => {
		expect(saveSkillOverrides(cwd, {}, { trusted: true })).toEqual({ ok: true, changed: 0 })
		expect(() => readFileSync(localSettingsPath(cwd), 'utf8')).toThrow()
	})

	it('says why when the file cannot be read, and leaves it as it is', () => {
		mkdirSync(join(cwd, '.namzu'), { recursive: true })
		writeFileSync(localSettingsPath(cwd), '{ not json')
		const saved = saveSkillOverrides(cwd, { a: 'off' }, { trusted: true })
		expect(saved.ok).toBe(false)
		expect(readFileSync(localSettingsPath(cwd), 'utf8')).toBe('{ not json')
	})

	it('refuses a skills value that is not a table', () => {
		mkdirSync(join(cwd, '.namzu'), { recursive: true })
		writeFileSync(localSettingsPath(cwd), JSON.stringify({ skills: 'yes' }))
		const saved = saveSkillOverrides(cwd, { a: 'off' }, { trusted: true })
		expect(saved).toMatchObject({ ok: false })
		expect(read()).toEqual({ skills: 'yes' })
	})

	it('writes nothing in a folder that is not trusted', () => {
		const saved = saveSkillOverrides(cwd, { a: 'off' }, { trusted: false })
		expect(saved).toMatchObject({ ok: false, message: expect.stringMatching(/not trusted/) })
	})
})
