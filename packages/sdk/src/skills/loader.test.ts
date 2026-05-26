import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverSkills, loadSkill } from './loader.js'

async function writeSkill(parent: string, name: string, content: string): Promise<string> {
	const dir = join(parent, name)
	await mkdir(dir, { recursive: true })
	await writeFile(join(dir, 'SKILL.md'), content, 'utf8')
	return dir
}

describe('Agent Skills loader', () => {
	it('parses standard Agent Skills frontmatter fields', async () => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-skills-'))
		const dir = await writeSkill(
			root,
			'delivery-briefing',
			[
				'---',
				'name: delivery-briefing',
				'description: Draft and edit grounded delivery briefings.',
				'license: MIT',
				'compatibility: Requires filesystem tools',
				'allowed-tools: read write edit',
				'metadata:',
				'  owner: vandal',
				'  version: "1.0"',
				'---',
				'Use grounded sources before drafting.',
				'',
			].join('\n'),
		)

		const result = await loadSkill(dir, 'metadata')

		expect(result.skill.metadata).toEqual({
			name: 'delivery-briefing',
			description: 'Draft and edit grounded delivery briefings.',
			license: 'MIT',
			compatibility: 'Requires filesystem tools',
			allowedTools: 'read write edit',
			metadata: {
				owner: 'vandal',
				version: '1.0',
			},
		})
		expect(result.skill.body).toBeUndefined()
	})

	it('loads the body only when the requested disclosure level is full', async () => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-skills-'))
		const dir = await writeSkill(
			root,
			'structured-file-authoring',
			[
				'---',
				'name: structured-file-authoring',
				'description: Create structured files with bounded edit chunks.',
				'---',
				'Use skeleton-first writes.',
				'',
			].join('\n'),
		)

		const metadataOnly = await loadSkill(dir, 'metadata')
		const full = await loadSkill(dir, 'full')

		expect(metadataOnly.skill.body).toBeUndefined()
		expect(full.skill.body).toBe('Use skeleton-first writes.')
	})

	it('discovers one-level skill directories deterministically', async () => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-skills-'))
		const a = await writeSkill(
			root,
			'a-skill',
			['---', 'name: a-skill', 'description: A skill.', '---', 'A'].join('\n'),
		)
		const b = await writeSkill(
			root,
			'b-skill',
			['---', 'name: b-skill', 'description: B skill.', '---', 'B'].join('\n'),
		)

		expect(await discoverSkills(root)).toEqual([a, b])
	})
})
