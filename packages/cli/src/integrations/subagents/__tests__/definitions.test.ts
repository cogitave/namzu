/**
 * The directories this application reads agent files from, and their order.
 *
 * What a file means is the kernel's and tested there; this covers the one
 * decision left here — user first, project second, project shadowing user.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { discoverAgentDefinitions, projectAgentsDir, userAgentsDir } from '../definitions.js'

let root: string
let home: string
let cwd: string

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-agents-'))
	home = join(root, 'home')
	cwd = join(root, 'project')
	mkdirSync(userAgentsDir(home), { recursive: true })
	mkdirSync(projectAgentsDir(cwd), { recursive: true })
})

afterEach(() => {
	removeTempDir(root)
})

describe('discoverAgentDefinitions', () => {
	it('reads ~/.namzu/agents then <cwd>/.namzu/agents, the project shadowing the user', async () => {
		writeFileSync(
			join(userAgentsDir(home), 'reviewer.md'),
			'---\nname: reviewer\ndescription: The user reviewer.\n---\nUser rules.',
		)
		writeFileSync(
			join(userAgentsDir(home), 'scribe.md'),
			'---\nname: scribe\ndescription: Writes docs.\n---\nWrite docs.',
		)
		writeFileSync(
			join(projectAgentsDir(cwd), 'reviewer.md'),
			'---\nname: reviewer\ndescription: The project reviewer.\n---\nProject rules.',
		)
		writeFileSync(join(projectAgentsDir(cwd), 'broken.md'), 'no frontmatter here')

		const { definitions, skipped } = await discoverAgentDefinitions({ cwd, home })

		expect(definitions.map((d) => [d.name, d.source, d.description])).toEqual([
			['reviewer', 'project', 'The project reviewer.'],
			['scribe', 'user', 'Writes docs.'],
		])
		expect(skipped.map((s) => s.path)).toEqual([join(projectAgentsDir(cwd), 'broken.md')])
	})

	it('contributes nothing when neither directory exists', async () => {
		const empty = mkdtempSync(join(tmpdir(), 'namzu-agents-none-'))
		try {
			expect(await discoverAgentDefinitions({ cwd: empty, home: empty })).toEqual({
				definitions: [],
				skipped: [],
				missingSkills: [],
			})
		} finally {
			removeTempDir(empty)
		}
	})

	it('loads the skills a file names into its prompt, and names the ones it cannot find', async () => {
		const skillDir = join(cwd, '.namzu', 'skills', 'release-notes')
		mkdirSync(skillDir, { recursive: true })
		writeFileSync(
			join(skillDir, 'SKILL.md'),
			'---\nname: release-notes\ndescription: Writes release notes.\n---\nLead with what breaks.',
		)
		writeFileSync(
			join(projectAgentsDir(cwd), 'scribe.md'),
			'---\nname: scribe\ndescription: Writes.\nskills: release-notes, nowhere\n---\nWrite it.',
		)

		const { definitions, missingSkills } = await discoverAgentDefinitions({ cwd, home })

		const scribe = definitions.find((d) => d.name === 'scribe')
		expect(scribe?.prompt).toContain('Write it.')
		expect(scribe?.prompt).toContain('### Skill: release-notes')
		expect(scribe?.prompt).toContain('Lead with what breaks.')
		expect(missingSkills).toEqual([
			{
				path: join(projectAgentsDir(cwd), 'scribe.md'),
				reason: 'skill nowhere was not found',
			},
		])
	})
})
