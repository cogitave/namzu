import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import { renderSkillsSection } from '../../persona/assembler.js'
import type { Skill } from '../../types/skills/index.js'
import { skillModelDescription } from '../../types/skills/index.js'
import { loadSkill } from '../loader.js'
import { SkillRegistry } from '../registry.js'

/**
 * A skill can say when the model should reach for it and how it runs: the
 * guidance, the agent type, the model, the effort and whether it waits.
 */

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

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

describe('the fields that shape how a skill runs are read', () => {
	it('reads when_to_use, context, agent, model, effort and background', async () => {
		const dir = await skillOnDisk(
			[
				'when_to_use: the user asks for a deep survey',
				'context: fork',
				'agent: explore',
				'model: small-model',
				'effort: high',
				'background: true',
				'',
			].join('\n'),
		)
		const { skill } = await loadSkill(dir)
		expect(skill.metadata).toMatchObject({
			whenToUse: 'the user asks for a deep survey',
			context: 'fork',
			agent: 'explore',
			model: 'small-model',
			effort: 'high',
			background: true,
		})
	})

	it.each(['', 'model: inherit\n'])('keeps effort independently of model (%s)', async (model) => {
		const { skill } = await loadSkill(await skillOnDisk(`context: fork\n${model}effort: high\n`))
		expect(skill.metadata.context).toBe('fork')
		expect(skill.metadata.model).toBeUndefined()
		expect(skill.metadata.effort).toBe('high')
	})

	it('leaves a skill that says none of it exactly as it was', async () => {
		const { skill } = await loadSkill(await skillOnDisk(''))
		expect(Object.keys(skill.metadata).sort()).toEqual(['description', 'name'])
	})

	it('ignores a value it does not understand instead of refusing the skill', async () => {
		const dir = await skillOnDisk(
			'context: sideways\neffort: 5000\nbackground: maybe\nmodel: inherit\n',
		)
		const { skill } = await loadSkill(dir)
		expect(Object.keys(skill.metadata).sort()).toEqual(['description', 'name'])
	})

	it('skips a spelling it cannot read in these fields instead of refusing the skill', async () => {
		const dir = await skillOnDisk(
			[
				'when_to_use: >-',
				'  the user asks',
				'  for a survey',
				'model: [a, b]',
				'effort:',
				'  - high',
				'context: fork',
				'',
			].join('\n'),
		)
		const { skill } = await loadSkill(dir)
		expect(skill.metadata.context).toBe('fork')
		expect(skill.metadata.whenToUse).toBeUndefined()
		expect(skill.metadata.model).toBeUndefined()
		expect(skill.metadata.effort).toBeUndefined()
	})

	it('still refuses a block scalar in a field it relies on', async () => {
		await expect(loadSkill(await skillOnDisk('invocation: >-\n  both\n'))).rejects.toThrow(
			/block scalar/,
		)
	})

	it('reads context: inline as no context at all', async () => {
		const { skill } = await loadSkill(await skillOnDisk('context: inline\n'))
		expect(skill.metadata.context).toBeUndefined()
	})
})

describe('when_to_use reaches the model beside the description', () => {
	it('joins the two in one place', () => {
		expect(skillModelDescription({ description: 'Does a thing.' })).toBe('Does a thing.')
		expect(skillModelDescription({ description: 'Does a thing.', whenToUse: 'On request.' })).toBe(
			'Does a thing. - On request.',
		)
	})

	it('is in the prompt manifest and in the skill tool catalog', async () => {
		const dir = await skillOnDisk('when_to_use: the user asks for a survey\n')
		const registry = new SkillRegistry()
		const skill: Skill = await registry.register(dir)
		expect(renderSkillsSection([skill])).toContain(
			'<description>does a thing - the user asks for a survey</description>',
		)
		const [entry] = await registry.catalog()
		expect(entry?.description).toBe('does a thing - the user asks for a survey')
	})
})
