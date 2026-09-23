import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { removeTempDir } from '../__fixtures__/temp-dir.js'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	agentsProjectSkillsDirs,
	composeSkillsPrompt,
	discoverSkills as discoverAll,
	discoverSkillRoster,
	loadSkillBody,
	parseSkillMarkdown,
	renderSkillRoster,
	systemSkillsDir,
} from './store.js'

let home: string
let cwd: string
let system: string

/** Discovery with an empty system tier, so the tests do not depend on what ships. */
function discoverSkills(opts: Parameters<typeof discoverAll>[0] = {}) {
	return discoverAll({ systemDir: system, ...opts })
}

function writeSkill(root: string, dir: string, contents: string) {
	const skillDir = join(root, 'skills', dir)
	mkdirSync(skillDir, { recursive: true })
	writeFileSync(join(skillDir, 'SKILL.md'), contents)
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-skh-'))
	cwd = mkdtempSync(join(tmpdir(), 'namzu-skc-'))
	system = mkdtempSync(join(tmpdir(), 'namzu-sks-'))
	mkdirSync(join(home, '.namzu'), { recursive: true })
})
afterEach(() => {
	removeTempDir(home)
	removeTempDir(cwd)
	removeTempDir(system)
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

function skillAt(skillsDir: string, name: string, description: string, extra = ''): string {
	mkdirSync(join(skillsDir, name), { recursive: true })
	const path = join(skillsDir, name, 'SKILL.md')
	writeFileSync(
		path,
		`---\nname: ${name}\ndescription: ${description}\n${extra}---\nBody of ${description}.`,
	)
	return path
}

describe('skill tiers', () => {
	it('resolve one name through all six tiers, highest precedence winning', () => {
		// A checkout root two levels above cwd, so the .agents walk has three stops.
		const repo = cwd
		mkdirSync(join(repo, '.git'))
		const work = join(repo, 'pkg', 'app')
		mkdirSync(work, { recursive: true })

		const paths = [
			skillAt(system, 'dup', 'system'),
			skillAt(join(home, '.agents', 'skills'), 'dup', 'agents-user'),
			skillAt(join(home, '.namzu', 'skills'), 'dup', 'user'),
			skillAt(join(work, 'skills'), 'dup', 'legacy'),
			skillAt(join(repo, '.agents', 'skills'), 'dup', 'agents-root'),
			skillAt(join(repo, 'pkg', '.agents', 'skills'), 'dup', 'agents-pkg'),
			skillAt(join(work, '.agents', 'skills'), 'dup', 'agents-cwd'),
			skillAt(join(work, '.namzu', 'skills'), 'dup', 'project'),
		]

		const roster = discoverSkillRoster({ home, cwd: work, systemDir: system })
		expect(roster.skills).toHaveLength(1)
		const winner = roster.skills[0]
		expect(winner?.description).toBe('project')
		expect(winner?.tier).toBe('project')
		expect(winner?.source).toBe('project')
		// Every lower tier is reported as shadowed, nearest first.
		expect(winner?.shadows).toEqual(paths.slice(0, -1).reverse())
		expect(roster.shadowed.map((s) => s.description)).toEqual([
			'agents-cwd',
			'agents-pkg',
			'agents-root',
			'legacy',
			'user',
			'agents-user',
			'system',
		])
		expect(roster.shadowed.every((s) => s.shadowedBy === paths.at(-1))).toBe(true)

		// Peel the tiers off from the top: each removal promotes the next one down.
		const order = [
			['project', 'project', 'project'],
			['agents-cwd', 'agents-project', 'project'],
			['agents-pkg', 'agents-project', 'project'],
			['agents-root', 'agents-project', 'project'],
			['legacy', 'legacy-project', 'project'],
			['user', 'user', 'user'],
			['agents-user', 'agents-user', 'user'],
			['system', 'system', 'system'],
		] as const
		for (const [index, [description, tier, source]] of order.entries()) {
			const found = discoverSkills({ home, cwd: work })[0]
			expect(found?.description).toBe(description)
			expect(found?.tier).toBe(tier)
			expect(found?.source).toBe(source)
			removeTempDir(dirname(paths[paths.length - 1 - index] as string))
		}
		expect(discoverSkills({ home, cwd: work })).toEqual([])
	})

	it('read .agents/skills only in cwd outside a checkout', () => {
		expect(agentsProjectSkillsDirs(cwd)).toEqual([join(cwd, '.agents', 'skills')])
	})

	it('walk .agents/skills from the checkout root down, shallowest first', () => {
		mkdirSync(join(cwd, '.git'))
		mkdirSync(join(cwd, 'a', 'b'), { recursive: true })
		expect(agentsProjectSkillsDirs(join(cwd, 'a', 'b'))).toEqual([
			join(cwd, '.agents', 'skills'),
			join(cwd, 'a', '.agents', 'skills'),
			join(cwd, 'a', 'b', '.agents', 'skills'),
		])
	})

	it('leave the system tier out when skills.builtin is false', () => {
		skillAt(system, 'shipped', 'a built-in')
		expect(discoverSkills({ home, cwd }).map((s) => s.name)).toEqual(['shipped'])
		expect(discoverSkills({ home, cwd, config: { builtin: false } })).toEqual([])
	})

	it('keep a disabled skill in the list, unusable, whichever tier it is in', () => {
		skillAt(system, 'noisy', 'built-in')
		skillAt(join(cwd, '.namzu', 'skills'), 'noisy', 'project copy')
		skillAt(join(cwd, '.namzu', 'skills'), 'kept', 'kept')
		const skills = discoverSkills({ home, cwd, config: { disabled: ['noisy'] } })
		const noisy = skills.find((s) => s.name === 'noisy')
		expect(noisy?.disabled).toBe(true)
		expect(noisy?.problem).toMatch(/skills\.disabled/)
		expect(() => loadSkillBody(noisy as NonNullable<typeof noisy>)).toThrow(/skills\.disabled/)
		expect(skills.find((s) => s.name === 'kept')?.disabled).toBeUndefined()
	})

	it('skip hidden and underscore directories, as the kernel does', () => {
		skillAt(join(cwd, '.namzu', 'skills'), '_draft', 'draft')
		expect(discoverSkills({ home, cwd })).toEqual([])
	})

	it('resolve the shipped tier to the package root from source and from dist', () => {
		// store.ts sits two levels below the package root in both layouts.
		expect(systemSkillsDir()).toBe(
			`${join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'skills')}/`,
		)
	})
})

describe('frontmatter the operator listing reads', () => {
	it('tolerates keys it does not read, whatever YAML they use', () => {
		const parsed = parseSkillMarkdown(
			'---\nname: pr\ndescription: reviews\nargument-hint: [pr-number]\nhooks:\n  PreToolUse:\n    - matcher: Bash\nmodel: opus\n---\nBody',
		)
		expect(parsed).toEqual({ name: 'pr', description: 'reviews', body: 'Body' })
	})

	it('maps disable-model-invocation: true to operator-only', () => {
		expect(
			parseSkillMarkdown('---\nname: a\ndescription: d\ndisable-model-invocation: true\n---\nB')
				.invocation,
		).toBe('operator')
	})

	it('reads metadata.namzu-requires-tools as a list', () => {
		expect(
			parseSkillMarkdown(
				'---\nname: a\ndescription: d\nmetadata:\n  namzu-requires-tools: "browser, browser_act"\n---\nB',
			).requiresTools,
		).toEqual(['browser', 'browser_act'])
	})
})

describe('renderSkillRoster', () => {
	it('names the tier, what a skill shadows, and why it is unusable', () => {
		skillAt(join(home, '.agents', 'skills'), 'dup', 'shared')
		skillAt(join(cwd, '.namzu', 'skills'), 'dup', 'mine')
		skillAt(
			join(cwd, '.namzu', 'skills'),
			'gated',
			'needs a browser',
			'disable-model-invocation: true\nmetadata:\n  namzu-requires-tools: browser\n',
		)
		const text = renderSkillRoster(
			discoverSkills({ home, cwd, config: { disabled: ['off'] } }),
			new Set(['dup']),
		)
		expect(text).toContain('● dup [./.namzu/skills] — mine')
		expect(text).toContain(`shadows ${join(home, '.agents', 'skills', 'dup', 'SKILL.md')}`)
		expect(text).toContain('operator only: not offered to the model')
		expect(text).toContain('offered to the model when these tools exist: browser')
	})
})
