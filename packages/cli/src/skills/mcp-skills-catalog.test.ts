import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type McpListedSkill, createSkillTool } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import type { McpSkillsView } from '../integrations/mcp/servers.js'
import { createSkillDirectoryResolver } from './directory.js'

import { createSessionSkillCatalog } from './catalog.js'

let home: string
let cwd: string
let system: string

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-mcpcat-home-'))
	cwd = mkdtempSync(join(tmpdir(), 'namzu-mcpcat-cwd-'))
	system = mkdtempSync(join(tmpdir(), 'namzu-mcpcat-sys-'))
})
afterEach(() => {
	removeTempDir(home)
	removeTempDir(cwd)
	removeTempDir(system)
})

function listed(name: string, description: string): McpListedSkill {
	const root = `skill://tickets/${name.split(':')[1]}`
	return {
		name,
		skill: { metadata: { name, description }, dirPath: root },
		entry: {
			uri: `${root}/SKILL.md`,
			root,
			name: name.split(':')[1] ?? name,
			description,
			frontmatter: { name: name.split(':')[1], description },
			digest: `sha256:${'0'.repeat(64)}`,
			size: 1,
			files: [],
		},
	}
}

function view(items: McpListedSkill[], loads: string[] = []): McpSkillsView {
	return {
		list: () => items,
		load: async (name) => {
			loads.push(name)
			const found = items.find((item) => item.name === name)
			return found
				? {
						skill: {
							metadata: found.skill.metadata,
							body: `body of ${name}`,
							dirPath: found.skill.dirPath,
						},
					}
				: undefined
		},
		onChange: () => () => {},
	}
}

function fileSkill(name: string): void {
	const dir = join(cwd, '.namzu', 'skills', name)
	mkdirSync(dir, { recursive: true })
	writeFileSync(
		join(dir, 'SKILL.md'),
		`---\nname: ${name}\ndescription: A local ${name}\n---\nBody.`,
	)
}

const turn = { toolNames: [] as string[], contextWindowTokens: 200_000 }

describe('skills from tool servers in the model catalogue', () => {
	it('offers none when no server was opted in', async () => {
		const catalog = await createSessionSkillCatalog({ cwd, home, systemDir: system })
		const out = await catalog.forTurn(turn)
		expect(out.manifest).toBeUndefined()
		expect(out.registry).toBeUndefined()
		const empty = await catalog.forTurn({ ...turn, mcpSkills: view([]) })
		expect(empty.manifest).toBeUndefined()
	})

	it('lists them after the local skills, with the server name in front', async () => {
		fileSkill('local-one')
		const catalog = await createSessionSkillCatalog({ cwd, home, systemDir: system })
		const out = await catalog.forTurn({
			...turn,
			mcpSkills: view([listed('tickets:triage', 'Sort tickets')]),
		})
		expect(out.manifest?.map((skill) => skill.metadata.name)).toEqual([
			'local-one',
			'tickets:triage',
		])
		expect(out.registry?.names()).toContain('tickets:triage')
		const entries = await out.registry?.catalog?.()
		expect(entries?.find((entry) => entry.registeredName === 'tickets:triage')).toEqual({
			registeredName: 'tickets:triage',
			description: 'Sort tickets',
			location: 'skill://tickets/triage/SKILL.md',
		})
	})

	it('loads a body through the server when the model asks for it, and no earlier', async () => {
		const loads: string[] = []
		const catalog = await createSessionSkillCatalog({ cwd, home, systemDir: system })
		const out = await catalog.forTurn({
			...turn,
			mcpSkills: view([listed('tickets:triage', 'Sort tickets')], loads),
		})
		expect(loads).toEqual([])
		const loaded = await out.registry?.load('tickets:triage')
		expect(loaded?.skill.body).toBe('body of tickets:triage')
		expect(loaded?.skill.metadata.allowedTools).toBeUndefined()
		expect(loads).toEqual(['tickets:triage'])
	})

	it('never lets a server take a name a local skill holds, and says so', async () => {
		fileSkill('tickets:triage'.replace(':', '-'))
		const warnings: string[] = []
		const catalog = await createSessionSkillCatalog({
			cwd,
			home,
			systemDir: system,
			log: {
				debug() {},
				info() {},
				warn: (message: string) => {
					warnings.push(message)
				},
				error() {},
				child() {
					return this
				},
			},
		})
		// A server skill whose full name equals a local one is dropped.
		const clash = listed('tickets-triage', 'Sort tickets')
		const out = await catalog.forTurn({ ...turn, mcpSkills: view([clash]) })
		expect(out.manifest?.map((skill) => skill.metadata.name)).toEqual(['tickets-triage'])
		expect(out.manifest?.[0]?.metadata.description).toBe('A local tickets-triage')
		expect(warnings.some((line) => line.includes('already taken'))).toBe(true)
	})

	it('keeps a long server listing from pushing local skills out of the manifest', async () => {
		fileSkill('local-one')
		const many = Array.from({ length: 200 }, (_, i) =>
			listed(`tickets:s${i}`, `Does thing number ${i} with a longish description for budget`),
		)
		const catalog = await createSessionSkillCatalog({ cwd, home, systemDir: system })
		const out = await catalog.forTurn({
			...turn,
			contextWindowTokens: 8_000,
			mcpSkills: view(many),
		})
		const names = out.manifest?.map((skill) => skill.metadata.name) ?? []
		expect(names[0]).toBe('local-one')
		expect(out.overflow.length).toBeGreaterThan(0)
		expect(out.overflow.every((name) => name.startsWith('tickets:'))).toBe(true)
	})

	it('goes through the skill tool: the body arrives, and no directory is claimed for it', async () => {
		const catalog = await createSessionSkillCatalog({ cwd, home, systemDir: system })
		const out = await catalog.forTurn({
			...turn,
			mcpSkills: view([listed('tickets:triage', 'Sort tickets')]),
		})
		const tool = createSkillTool({
			resolveModelDirectory: createSkillDirectoryResolver({ sandboxMounts: () => [] }),
		})
		const result = await tool.execute({ name: 'tickets:triage' }, {
			skills: out.registry,
			maxToolOutputChars: 50_000,
		} as never)
		expect(result.success).toBe(true)
		expect(result.output).toContain('body of tickets:triage')
	})
})

describe('the directory the model may open', () => {
	it('is none for a skill that has an address and not a folder', async () => {
		const resolve = createSkillDirectoryResolver({ sandboxMounts: () => [] })
		expect(
			await resolve({ name: 'tickets:triage', directory: 'skill://tickets/triage' }, {}),
		).toBeUndefined()
		expect(await resolve({ name: 'x', directory: join(cwd) }, {})).toBe(cwd)
	})
})
