import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDir } from '../__fixtures__/temp-dir.js'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { composeSkillsPrompt, discoverSkills, loadSkillBody, parseSkillMarkdown } from './store.js'

let home: string
let cwd: string

function writeSkill(root: string, dir: string, contents: string) {
	const skillDir = join(root, 'skills', dir)
	mkdirSync(skillDir, { recursive: true })
	writeFileSync(join(skillDir, 'SKILL.md'), contents)
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-skh-'))
	cwd = mkdtempSync(join(tmpdir(), 'namzu-skc-'))
	mkdirSync(join(home, '.namzu'), { recursive: true })
})
afterEach(() => {
	removeTempDir(home)
	removeTempDir(cwd)
})

describe('parseSkillMarkdown', () => {
	it('splits frontmatter from body', () => {
		const parsed = parseSkillMarkdown(
			'---\nname: Pirate\ndescription: talk like a pirate\n---\nArr matey.',
		)
		expect(parsed.name).toBe('Pirate')
		expect(parsed.description).toBe('talk like a pirate')
		expect(parsed.body).toBe('Arr matey.')
	})

	it('treats a file with no frontmatter as all body', () => {
		const parsed = parseSkillMarkdown('just a body')
		expect(parsed.name).toBeUndefined()
		expect(parsed.body).toBe('just a body')
	})

	// The defect this adoption exists to close. The old reader's regex was
	// `/^---\n…\n---\n?/` — LF only — so a SKILL.md saved on Windows matched
	// nothing, the whole file became body, and the skill was listed under its
	// directory name with "(no description)". It did not fail; it described the
	// skill wrongly.
	it('reads CRLF frontmatter, which the previous reader silently ignored', () => {
		const parsed = parseSkillMarkdown(
			'---\r\nname: Pirate\r\ndescription: talk like a pirate\r\n---\r\nArr matey.',
		)
		expect(parsed.name).toBe('Pirate')
		expect(parsed.description).toBe('talk like a pirate')
		expect(parsed.body).toBe('Arr matey.')
	})

	it('refuses frontmatter it cannot read, rather than calling it absent', () => {
		// An author who opened a fence and got the contents wrong is not the
		// same as an author who wrote no frontmatter. Answering the first with
		// "no metadata, carry on" put the broken YAML into the body and from
		// there into the system prompt.
		expect(() => parseSkillMarkdown('---\nname: x\nbody with no closing fence')).toThrow()
	})

	it('names the source in the refusal, so the operator knows which file', () => {
		expect(() => parseSkillMarkdown('---\nunclosed', '/skills/broken/SKILL.md')).toThrow(
			/\/skills\/broken\/SKILL\.md/,
		)
	})

	it('still treats a file with no fence as all body, which is documented', () => {
		// The supported shape promises this, and the refusal above must not
		// have taken it with it.
		const parsed = parseSkillMarkdown('# Just a heading\n\nand prose.')
		expect(parsed.name).toBeUndefined()
		expect(parsed.body).toBe('# Just a heading\n\nand prose.')
	})
})

describe('discoverSkills', () => {
	it('returns empty when no skill dirs exist', () => {
		expect(discoverSkills({ home, cwd })).toEqual([])
	})

	it('discovers user + project skills, falling back to dir name', () => {
		writeSkill(join(home, '.namzu'), 'greet', '---\ndescription: greets\n---\nSay hi.')
		writeSkill(cwd, 'lint', 'no frontmatter body')
		const skills = discoverSkills({ home, cwd })
		expect(skills.map((s) => s.name).sort()).toEqual(['greet', 'lint'])
		const greet = skills.find((s) => s.name === 'greet')
		expect(greet?.source).toBe('user')
		expect(greet?.description).toBe('greets')
		expect(skills.find((s) => s.name === 'lint')?.description).toBe('(no description)')
	})

	it('lets a project skill shadow a user skill of the same name', () => {
		writeSkill(join(home, '.namzu'), 'dup', '---\nname: dup\ndescription: user version\n---\nU')
		writeSkill(cwd, 'dup', '---\nname: dup\ndescription: project version\n---\nP')
		const skills = discoverSkills({ home, cwd })
		const dup = skills.filter((s) => s.name === 'dup')
		expect(dup).toHaveLength(1)
		expect(dup[0]?.source).toBe('project')
		expect(dup[0]?.description).toBe('project version')
	})
})

describe('loadSkillBody', () => {
	it('returns the body of a discovered skill', () => {
		writeSkill(cwd, 'greet', '---\nname: greet\n---\nAlways greet warmly.')
		const info = discoverSkills({ home, cwd }).find((s) => s.name === 'greet')
		expect(info && loadSkillBody(info)).toBe('Always greet warmly.')
	})
})

describe('composeSkillsPrompt', () => {
	it('returns null when nothing is active', () => {
		expect(composeSkillsPrompt([])).toBeNull()
	})

	it('frames each active skill', () => {
		const prompt = composeSkillsPrompt([{ name: 'greet', body: 'Say hi.' }])
		expect(prompt).toContain('### Skill: greet')
		expect(prompt).toContain('Say hi.')
	})
})
