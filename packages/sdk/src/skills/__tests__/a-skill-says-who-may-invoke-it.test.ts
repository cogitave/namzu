import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import { assembleSystemPrompt, renderSkillsSection } from '../../persona/assembler.js'
import { kernelHostCommands } from '../../registry/command/kernel-commands.js'
import {
	SKILL_INVOCATION_DEFAULT,
	type Skill,
	type SkillInvocation,
	isInvocableBy,
	skillInvocation,
} from '../../types/skills/index.js'
import { loadSkill } from '../loader.js'

/**
 * Who may reach for a skill.
 *
 * Every skill was offered to the model and to nobody else, and both halves
 * of that are wrong. A skill only an operator can meaningfully run — "collect
 * a support bundle", "rotate the deploy key" — sat in the model's manifest as
 * something to attempt, and the model would attempt it. A skill that is pure
 * model guidance had no way to be offered to an operator at all.
 */

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

const skill = (name: string, invocation?: SkillInvocation, body?: string): Skill =>
	({
		metadata: { name, description: `does ${name}`, ...(invocation ? { invocation } : {}) },
		dirPath: `/tmp/${name}`,
		...(body ? { body } : {}),
	}) as Skill

async function skillOnDisk(frontmatter: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'namzu-skill-'))
	dirs.push(root)
	const dir = join(root, 'the-skill')
	await mkdir(dir, { recursive: true })
	await writeFile(
		join(dir, 'SKILL.md'),
		`---\nname: the-skill\ndescription: does a thing\n${frontmatter}---\n\nbody\n`,
		'utf-8',
	)
	return dir
}

describe('a skill that says nothing is invocable by both', () => {
	it('resolves the default in one place', () => {
		// One decision, one resolver. Four readers each writing `?? 'both'`
		// is three chances for them to disagree.
		expect(skillInvocation(skill('a'))).toBe(SKILL_INVOCATION_DEFAULT)
		expect(SKILL_INVOCATION_DEFAULT).toBe('both')
	})

	it('satisfies either audience', () => {
		// The only reason a third value exists: a two-value policy would force
		// every author to pick a side for a skill that genuinely serves both.
		expect(isInvocableBy(skill('a'), 'model')).toBe(true)
		expect(isInvocableBy(skill('a'), 'operator')).toBe(true)
	})

	it('narrows only when the author says so', () => {
		expect(isInvocableBy(skill('a', 'operator'), 'model')).toBe(false)
		expect(isInvocableBy(skill('a', 'operator'), 'operator')).toBe(true)
		expect(isInvocableBy(skill('a', 'model'), 'model')).toBe(true)
		expect(isInvocableBy(skill('a', 'model'), 'operator')).toBe(false)
	})
})

describe('the model’s manifest carries only what the model may invoke', () => {
	it('leaves an operator-only skill out', () => {
		// Listing it is not merely noise: the model reads it as available and
		// attempts it, and the attempt is the failure.
		const section = renderSkillsSection([skill('model-one'), skill('ops-one', 'operator')])

		expect(section).toContain('model-one')
		expect(section).not.toContain('ops-one')
	})

	it('says nothing at all when every skill is operator-only', () => {
		// An empty `<available_skills>` block tells the model it has a skills
		// system with nothing in it, which is a different and less useful
		// claim than saying nothing.
		expect(renderSkillsSection([skill('ops-one', 'operator')])).toBeNull()
	})

	it('does NOT paste an operator-only skill’s body into the prompt', () => {
		// The worst of both: the model gets the instructions and no listing it
		// could reason about them from.
		const section = renderSkillsSection([
			skill('model-one'),
			skill('ops-one', 'operator', 'SECRET OPERATOR BODY'),
		])

		expect(section).not.toContain('SECRET OPERATOR BODY')
	})

	it('still carries a model-only skill’s body', () => {
		const section = renderSkillsSection([skill('model-one', 'model', 'THE MODEL BODY')])

		expect(section).toContain('THE MODEL BODY')
	})

	it('reaches the assembled persona prompt the same way', () => {
		const prompt = assembleSystemPrompt({ identity: { role: 'A', description: 'x' } }, [
			skill('model-one'),
			skill('ops-one', 'operator'),
		])

		expect(prompt).toContain('model-one')
		expect(prompt).not.toContain('ops-one')
	})
})

describe('the operator’s menu carries only what an operator may invoke', () => {
	const skillsCommand = (skills?: readonly Skill[]) => {
		const command = kernelHostCommands(skills ? { skills } : {}).find((c) => c.name === 'skills')
		if (!command) throw new Error('no /skills command')
		return command
	}

	it('lists an operator-invocable skill', async () => {
		const result = await skillsCommand([skill('ops-one', 'operator')]).handler({ args: [] })

		expect(result).toMatchObject({ kind: 'report' })
		expect(JSON.stringify(result)).toContain('ops-one')
	})

	it('leaves a model-only skill out', async () => {
		// The other half of the split: offering an operator something there is
		// no way for them to run.
		const result = await skillsCommand([skill('model-one', 'model')]).handler({ args: [] })

		expect(JSON.stringify(result)).not.toContain('model-one')
	})

	it('carries the policy on each row, so the menu explains itself', async () => {
		const result = await skillsCommand([skill('shared')]).handler({ args: [] })

		expect(JSON.stringify(result)).toContain('both')
	})

	it('refuses when the run has no skills registry at all', async () => {
		// "No skills" and "no registry" are different answers, and showing the
		// first for the second gives an operator a confident zero nobody
		// computed.
		const result = await skillsCommand().handler({ args: [] })

		expect(result).toMatchObject({ kind: 'refused' })
	})

	it('reports an empty list when the registry holds none for an operator', async () => {
		// Unlike the missing registry: the question was asked and answered.
		const result = await skillsCommand([skill('model-one', 'model')]).handler({ args: [] })

		expect(result).toMatchObject({ kind: 'report', rows: [] })
	})
})

describe('the frontmatter field', () => {
	it('is read off disk', async () => {
		const dir = await skillOnDisk('invocation: operator\n')

		const { skill: loaded } = await loadSkill(dir)

		expect(loaded.metadata.invocation).toBe('operator')
	})

	it('is absent when the file says nothing, rather than defaulted at parse', async () => {
		// The default lives in `skillInvocation`, so a stored skill records
		// what its author wrote and not what this version happened to default
		// to — which is what lets the default change without rewriting files.
		const dir = await skillOnDisk('')

		const { skill: loaded } = await loadSkill(dir)

		expect(loaded.metadata.invocation).toBeUndefined()
		expect(skillInvocation(loaded)).toBe('both')
	})

	it('REFUSES a value that is not one of the three', async () => {
		// A typo'd value that quietly resolved to `both` would put an
		// operator-only skill back in front of the model — exactly what the
		// field was added to stop — and the author would have no way to tell.
		const dir = await skillOnDisk('invocation: opreator\n')

		await expect(loadSkill(dir)).rejects.toThrow(/invocation must be one of/)
	})
})
