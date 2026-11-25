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
				refused: [],
				carriers: [],
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

describe('discoverAgentDefinitions and hooks', () => {
	const guard = (type: string) =>
		[
			'hooks:',
			'  PreToolUse:',
			'    - matcher: Bash',
			'      hooks:',
			`        - type: ${type}`,
			'          command: ./guard.sh',
		].join('\n')
	const file = (name: string, hooks: string) =>
		`---\nname: ${name}\ndescription: Runs commands.\n${hooks}\n---\nYou run commands.`

	it('keeps the hooks text of an agent file and offers it', async () => {
		writeFileSync(join(projectAgentsDir(cwd), 'ok.md'), file('ok', guard('command')))
		const found = await discoverAgentDefinitions({ cwd, home })
		expect(found.definitions.map((d) => d.name)).toEqual(['ok'])
		expect(found.definitions[0]?.hooksSource).toContain('PreToolUse')
		expect(found.refused).toEqual([])
		expect(found.carriers.map((c) => c.name)).toEqual(['ok'])
	})

	it('does not offer a file whose guard cannot be loaded, and names it with the entry', async () => {
		writeFileSync(join(projectAgentsDir(cwd), 'bad.md'), file('bad', guard('nope')))
		writeFileSync(join(projectAgentsDir(cwd), 'ok.md'), file('ok', guard('command')))
		const found = await discoverAgentDefinitions({ cwd, home })
		expect(found.definitions.map((d) => d.name)).toEqual(['ok'])
		expect(found.refused.map((r) => r.name)).toEqual(['bad'])
		expect(found.refused[0]?.line).toContain(join(projectAgentsDir(cwd), 'bad.md'))
		expect(found.refused[0]?.line).toContain('PreToolUse group 1, hook 1')
		// Said where skipped files are said.
		expect(found.skipped.map((s) => s.path)).toContain(join(projectAgentsDir(cwd), 'bad.md'))
		expect(found.carriers.map((c) => c.name).sort()).toEqual(['bad', 'ok'])
	})

	it('does not let a broken project file leave the user’s file of the same name offered', async () => {
		writeFileSync(join(userAgentsDir(home), 'same.md'), file('same', guard('command')))
		writeFileSync(join(projectAgentsDir(cwd), 'same.md'), file('same', guard('nope')))
		const found = await discoverAgentDefinitions({ cwd, home })
		expect(found.definitions).toEqual([])
		expect(found.refused.map((r) => r.name)).toEqual(['same'])
	})

	it('does not offer a project file with a guard in a folder that is not trusted', async () => {
		writeFileSync(join(projectAgentsDir(cwd), 'ok.md'), file('ok', guard('command')))
		const found = await discoverAgentDefinitions({ cwd, home, hooks: { projectTrusted: false } })
		expect(found.definitions).toEqual([])
		expect(found.refused[0]?.line).toContain('not trusted')
	})

	it('offers it as if it had no hooks when a switch is on', async () => {
		writeFileSync(join(projectAgentsDir(cwd), 'bad.md'), file('bad', guard('nope')))
		const found = await discoverAgentDefinitions({
			cwd,
			home,
			hooks: { projectTrusted: true, hooksSwitch: 'disabled' },
		})
		expect(found.definitions.map((d) => d.name)).toEqual(['bad'])
		expect(found.refused).toEqual([])
	})
})

describe('a skill preloaded into an agent that holds shell commands', () => {
	function agentWithSkill(body: string, allowedTools?: string): void {
		const skillDir = join(cwd, '.namzu', 'skills', 'status')
		mkdirSync(skillDir, { recursive: true })
		writeFileSync(
			join(skillDir, 'SKILL.md'),
			`---\nname: status\ndescription: Status\n${allowedTools ? `allowed-tools: ${allowedTools}\n` : ''}---\n${body}`,
		)
		writeFileSync(
			join(projectAgentsDir(cwd), 'ops.md'),
			'---\nname: ops\ndescription: Ops.\nskills: status\n---\nYou run ops.',
		)
	}

	it('is not run by default: each command is replaced by a line saying so, so listing never runs one', async () => {
		agentWithSkill('Now: !`date`\n```!\nls\n```')
		const { definitions, missingSkills } = await discoverAgentDefinitions({ cwd, home })
		const prompt = definitions.find((d) => d.name === 'ops')?.prompt ?? ''
		expect(missingSkills).toEqual([])
		expect(prompt).toContain('Now: [shell commands in a skill preloaded into an agent are not run')
		expect(prompt).not.toContain('!`date`')
		expect(prompt).not.toContain('```!')
	})

	it('is run when the caller gives an expander, as `other`, with the skill’s own tier and allowed-tools', async () => {
		agentWithSkill('Now: !`date`', 'Bash(date)')
		const seen: Record<string, unknown>[] = []
		const { definitions } = await discoverAgentDefinitions({
			cwd,
			home,
			skillShell: {
				expand: async (request) => {
					seen.push({ ...request })
					return request.text.replace('!`date`', 'TODAY')
				},
			},
		})
		expect(definitions.find((d) => d.name === 'ops')?.prompt).toContain('Now: TODAY')
		expect(seen[0]).toMatchObject({
			name: 'status',
			origin: 'project',
			invokedBy: 'other',
			allowedTools: 'Bash(date)',
		})
	})

	it('names the skill that could not load when a command fails, and the agent still loads', async () => {
		agentWithSkill('!`false`')
		const { definitions, missingSkills } = await discoverAgentDefinitions({
			cwd,
			home,
			skillShell: {
				expand: async () => {
					throw new Error('Shell command failed for pattern "false": exit code 1')
				},
			},
		})
		expect(definitions.map((d) => d.name)).toContain('ops')
		expect(missingSkills[0]?.reason).toContain('could not be read: Shell command failed')
	})

	it('leaves a skill with no commands exactly as it was', async () => {
		agentWithSkill('Plain text with `code`.')
		const { definitions } = await discoverAgentDefinitions({ cwd, home })
		expect(definitions.find((d) => d.name === 'ops')?.prompt).toContain(
			'### Skill: status\n\nPlain text with `code`.',
		)
	})
})
